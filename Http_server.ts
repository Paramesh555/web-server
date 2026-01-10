import { validateHeaderName } from "http";
import * as net from "net";

const KMaxHeaderLen = 1024 * 8;
const CRLF = Buffer.from('\r\n');

/* ===================== Types ===================== */

type TCPConn = {
    socket: net.Socket;
    err: null | Error;
    ended: boolean;
    reader: null | {
        resolve: (value: Buffer) => void;
        reject: (reason: Error) => void;
    };
};

type TCPListner = {
    server: net.Server;
    err: null | Error;
    accepter: null | {
        resolve: (conn: TCPConn) => void;
        reject: (err: Error) => void;
    };
};

type DynBuf = {
    data: Buffer;     // allocated memory
    size: number;     // bytes actually used
    start: number;    // start of unread data
};

type BodyReader = {
    length: number,
    read: () => Promise<Buffer>;
}


// a parsed HTTP request header
type HTTPReq = {
    method: string,
    uri: Buffer,
    version: string,
    headers: Buffer[],
};

// an HTTP response
type HTTPRes = {
    code: number,
    headers: Buffer[],
    body: BodyReader,
};

//an HTTP Error class
class HTTPError{
    errorCode: number;
    error: string

    constructor(errorCode: number, error: string){
        this.errorCode = errorCode;
        this.error = error;
    }
}

/* ===================== TCPConn ===================== */

function soInit(socket: net.Socket): TCPConn {
    const conn: TCPConn = {
        socket,
        err: null,
        ended: false,
        reader: null,
    };

    socket.on("data", (data: Buffer) => {
        socket.pause();
        conn.reader?.resolve(data);
        conn.reader = null;
    });

    socket.on("end", () => {
        conn.ended = true;
        if (conn.reader) {
            conn.reader.resolve(Buffer.from(""));
            conn.reader = null;
        }
    });

    socket.on("error", (err: Error) => {
        conn.err = err;
        if (conn.reader) {
            conn.reader.reject(err);
            conn.reader = null;
        }
    });

    return conn;
}

/* ===================== Buffer Helpers ===================== */
function bufPush(buf: DynBuf, data: Buffer) {
    const newLen = buf.size + data.length;

    if (newLen > buf.data.length) {
        let cap = Math.max(buf.data.length, 32);
        while (cap < newLen) {
            cap *= 2;
        }

        const grown = Buffer.alloc(cap);
        //here we can remove the already read data
        buf.data.copy(grown, 0, 0, buf.size);

        buf.data = grown;
    }
    data.copy(buf.data, buf.size); //copy(dst, dstStart, srcStart)
    buf.size = newLen;
}

function bufPop(buf: DynBuf, len: number) {
    //only do copywithin when the capacity reaches the half
    if (buf.start > buf.data.length / 2) {
        buf.data.copyWithin(0, len, buf.size); //buf.copyWithin(dst, src_start, src_end)
        buf.size -= len;
        buf.start = 0;
    } else {
        buf.start += len;
    }
}

//remove and return the http header
function cutMessage(buf: DynBuf): HTTPReq | null {
    // the end of the header is marked by '\r\n\r\n'
    const relativeIdx = buf.data
        .subarray(buf.start, buf.size)
        .indexOf('\r\n\r\n');



    if (relativeIdx < 0) {
        if (buf.size >= KMaxHeaderLen) {
            throw new HTTPError(413, 'header is too large');
        }
        return null;
    }
    const absoluteIdx = relativeIdx + buf.start;

    // parse & remove the header
    const msg = parseHTTPReq(buf.data.subarray(buf.start, absoluteIdx + 4));

    bufPop(buf, relativeIdx + 4);
    return msg;
}

function parseHTTPReq(data: Buffer): HTTPReq {
    // split the data into lines
    const lines: Buffer[] = splitwithgivenRegex(data, CRLF);
    // the first line is `METHOD URI VERSION`

    const [method, uri, version] = parseRequestLine(lines[0]);

    const headers: Buffer[] = [];
    // the header ends by an empty line
    for (let i = 1; i < lines.length - 1; i++) {
        const h = Buffer.from(headers[i]);
        if (!validateHeader(h)) {
            throw new HTTPError(400, 'bad field');
        }
        headers.push(h);
    }

    console.assert(lines[lines.length - 1].length === 0);
    return {
        method: method, uri: uri, version: version, headers: headers,
    };
}

function validateHeader(line: Buffer): boolean {
    // reject embedded CR or LF
    if (line.indexOf(0x0d) !== -1 || line.indexOf(0x0a) !== -1) {
        return false;
    }

    const colonIdx = line.indexOf(0x3a); // ':'

    // must have a colon and non-empty name
    if (colonIdx <= 0) {
        return false;
    }

    // allow anything in value (simple validation)
    return true;
}


function parseRequestLine(reqestFirstLine: Buffer): [string, Buffer, string] {
    const SP = Buffer.from(' ');

    const parts = splitwithgivenRegex(reqestFirstLine, SP);

    if (parts.length !== 3) {
        throw new Error("malformed request line");
    }

    const method = parts[0].toString('ascii');
    const uri = parts[1];
    const version = parts[2].toString("ascii");

    return [method, uri, version];
}

function splitwithgivenRegex(data: Buffer, regex: Buffer): Buffer[] {
    const lines: Buffer[] = [];
    let start = 0;

    let idx = 0;
    while ((idx = data.indexOf(regex, start)) !== -1) {
        lines.push(data.subarray(start, idx));
        start = idx + regex.length;
    }

    if (start < data.length) {
        lines.push(data.subarray(start));
    }

    return lines;
}

function readerFromReq(conn: TCPConn, buf: DynBuf, req: HTTPReq): BodyReader {
    let bodyLen = -1;
    const contentLen = fieldGet(req.headers, 'Content-Length');
    if (contentLen) {
        bodyLen = parseDec(contentLen.toString('latin1'));
        if (isNaN(bodyLen)) {
            throw new HTTPError(400, 'bad Content-Length.');
        }
    }
    const bodyAllowed = !(req.method === 'GET' || req.method === 'HEAD');

    const chunked = fieldGet(req.headers, 'Transfer-Encoding')?.equals(Buffer.from('chunked')) || false;
    if (!bodyAllowed && (bodyLen > 0 || chunked)) {
        throw new HTTPError(400, 'http body not allowed');
    }

    if (!bodyAllowed) {
        bodyLen = 0;
    }

    if (bodyLen >= 0) {
        // "Content-Length" is present
        return readerFromConnLength(conn, buf, bodyLen);
    } else if (chunked) {
        // chunked encoding
        throw new HTTPError(501, 'TODO');
    } else {
        // read the rest of the connection
        throw new HTTPError(501, 'TODO');
    }

}

function readerFromConnLength(conn:TCPConn, buf: DynBuf, remain: number): BodyReader {
    return {
        length: remain,
        read: async(): Promise<Buffer> => {
            if(remain === 0){
                return Buffer.from(''); //done
            }

            if(buf.size === 0){
                //need to get more data
                const data = await soRead(conn);
                bufPush(buf,data);
                if(data.length === 0){
                    //error
                    throw new Error('Unexpected EOF from HTTP body');
                }
            }
            //consume data from buffer
            const consume = Math.min(buf.size,remain);
            remain -= consume;
            const data = Buffer.from(buf.data.subarray(0, consume));
            bufPop(buf,consume);
            return data;
        }
    }
}

function fieldGet(headers: Buffer[], key: string): null | Buffer {
    const lowerKey = key.toLowerCase();

    for (const line of headers) {
        const str = line.toString();

        const idx = str.indexOf(':');
        const headerKey = str.substring(0,idx);
        if(headerKey === lowerKey){
            return Buffer.from(str.substring(idx+1));
        }

    }
    return null;
}


function handleReq(reqHeader: HTTPReq, reqBody: BodyReader): Promise<HTTPRes>{
    let resp: BodyReader;
    switch(reqHeader.uri.toString('latin1')){
        case '/echo':
            resp = reqBody;
            break;
        default:
            resp = readerFromMemory(Buffer.from('hello world\n'));
            break;
    }

    return {
        code: 200,
        headers: [Buffer.from('server: my_first_http_server')],
        body:resp,
    };
}

function readerFromMemory(data: Buffer): BodyReader{
    let done = false;
    return{
        length: data.length,
        read: async(): Promise<Buffer> => {
            if(done){
                return Buffer.from('');
            }else{
                done = true;
                return data;
            }
        }
    };
}

function writeHTTPResp(conn: TCPConn, resp: HTTPRes): Promise<void>{
    
}


/* ===================== Socket IO ===================== */

function soRead(conn: TCPConn): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        if (conn.err) {
            reject(conn.err);
            return;
        }

        if (conn.ended) {
            resolve(Buffer.from("")); // EOF
            return;
        }

        conn.reader = { resolve, reject };
        conn.socket.resume();
    });
}



/* ===================== Echo Server ===================== */

async function serveClient(socket: net.Socket): Promise<void> {
    const conn = soInit(socket);
    const buf: DynBuf = {
        data: Buffer.alloc(0),
        size: 0,
        start: 0,
    };

    while (true) {
        const msg: null | HTTPReq = cutMessage(buf);

        if (!msg) {
            const data = await soRead(conn);
            bufPush(buf, data);

            if (data.length === 0 && buf.size === 0) {
                return;
            }

            if (data.length === 0) {
                throw new HTTPError(400, 'Unexpected EOF.');
            }
            continue;
        }

        const reqBody: BodyReader = readerFromReq(conn, buf, msg);
        const res: HTTPRes = await handleReq(msg, reqBody);
        await writeHTTPResp(conn, res);

        // close the connection for HTTP/1.0
        if (msg.version === '1.0') {
            return;
        }
        // make sure that the request body is consumed completely
        while ((await reqBody.read()).length > 0) { /* empty */ }
    }
}

/* ===================== Listener ===================== */

function soListen(host: string, port: number): TCPListner {
    const server = net.createServer({ pauseOnConnect: true });

    const listener: TCPListner = {
        server,
        err: null,
        accepter: null,
    };

    server.on("connection", (socket) => {
        const conn = soInit(socket);
        listener.accepter?.resolve(conn);
        listener.accepter = null;
    });

    server.on("error", (err) => {
        listener.err = err;
        listener.accepter?.reject(err);
        listener.accepter = null;
    });

    server.listen({ host, port });
    return listener;
}

function soAccept(listener: TCPListner): Promise<TCPConn> {
    return new Promise((resolve, reject) => {
        if (listener.err) {
            reject(listener.err);
            return;
        }

        listener.accepter = { resolve, reject };
    });
}

/* ===================== Main ===================== */

async function main() {
    const listener = soListen("127.0.0.1", 1234);

    while (true) {
        const conn = await soAccept(listener);
        try {
            serveClient(conn.socket); // fire-and-forget
        } catch (exc) {
            console.error('exception:', exc);
            if (exc instanceof HTTPError) {
                // intended to send an error response
                const resp: HTTPRes = {
                    code: exc.code,
                    headers: [],
                    body: readerFromMemory(Buffer.from(exc.message + '\n')),
                };
                try {
                    await writeHTTPResp(conn, resp);
                } catch (exc) { /* ignore */ }
            }
        } finally {
            conn.socket.destroy();
        }

    }
}

main().catch((err) => {
    console.error("fatal:", err);
});

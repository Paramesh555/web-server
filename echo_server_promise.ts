import * as net from "net";

type TCPConn = {
    socket: net.Socket;
    err: null | Error;
    ended: boolean;
    reader: null | {
        resolve: (value: Buffer) => void;
        reject: (reason: Error) => void;
    }
}

type TCPListner = {
    server: net.Server;
    err: null | Error;
    accepter: null | {
        resolve: (conn: TCPConn) => void;
        reject: (err: Error) => void;
    };
};

//create a wrapper
function soInit(socket: net.Socket): TCPConn {
    const conn: TCPConn = {
        socket: socket, err: null, ended: false, reader: null,
    };

    socket.on('data', (data: Buffer) => {
        conn.socket.pause();
        conn.reader?.resolve(data);
        conn.reader = null;
    })

    socket.on('end', () => {
        conn.ended = true;
        if (conn.reader) {
            conn.reader.resolve(Buffer.from(''));
            conn.reader = null;
        }
    });

    socket.on('error', (err: Error) => {
        conn.err = err;
        if (conn.reader) {
            conn.reader.reject(err);
            conn.reader = null;
        }
    });

    return conn;
}

function soRead(conn: TCPConn): Promise<Buffer> {
    //create the promise which will be resolved in the 'data' event
    return new Promise((resolve, reject) => {
        if (conn.err) {
            reject(conn.err);
            return;
        }

        if (conn.ended) {
            resolve(Buffer.from('')); // EOF
            return;
        }

        conn.reader = { resolve: resolve, reject: reject };
        conn.socket.resume();
    });
}

function soWrite(conn: TCPConn, data: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
        if (conn.err) {
            reject(conn.err);
            return;
        }

        conn.socket.write(data, (err) => {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });
}


//echo server
async function serveClient(socket: net.Socket): Promise<void> {
    const conn: TCPConn = soInit(socket);
    while (true) {
        const data = await soRead(conn);
        if (data.length === 0) {
            console.log('end connection');
            break;
        }

        console.log('data', data);
        await soWrite(conn, data);
    }
}

async function newConn(socket: net.Socket) {
    console.log('new connection', socket.remoteAddress, socket.remotePort);
    try {
        await serveClient(socket);
    } catch (exc) {
        console.error('exception:', exc);
    } finally {
        socket.destroy();
    }
}

function soListen(host: string, port: number): TCPListner {
    const server = net.createServer({
        pauseOnConnect: true,   // required by `TCPConn`
    });

    const listener: TCPListner = {
        server,
        err: null,
        accepter: null,
    };

    server.on('connection', (socket) => {
        const conn = soInit(socket);

        listener.accepter?.resolve(conn);
        listener.accepter = null;
    });

    server.on('error', (err) => {
        listener.err = err;
        if (listener.accepter) {
            listener.accepter.reject(err);
            listener.accepter = null;
        }
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

async function main() {
    const listener = soListen("127.0.0.1", 1234);

    while (true) {
        const conn = await soAccept(listener);
        serveClient(conn.socket); // fire-and-forget
    }
}

main().catch(err => {
    console.error("fatal:", err);
});



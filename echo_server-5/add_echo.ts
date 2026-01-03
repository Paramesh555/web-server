import * as net from "net";

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
};

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
        buf.data.copy(grown, 0, 0);
        buf.data = grown;
    }

    data.copy(buf.data, buf.size);
    buf.size = newLen;
}

function bufPop(buf: DynBuf, len: number) {
    buf.data.copyWithin(0, len, buf.size);
    buf.size -= len;
}

function cutMessage(buf: DynBuf): Buffer | null {
    const idx = buf.data
        .subarray(0, buf.size)
        .indexOf("\n");

    if (idx < 0) {
        return null;
    }

    const msg = Buffer.from(
        buf.data.subarray(0, idx + 1)
    );

    bufPop(buf, idx + 1);
    return msg;
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

function soWrite(conn: TCPConn, data: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
        if (conn.err) {
            reject(conn.err);
            return;
        }

        conn.socket.write(data, (err) => {
            if (err) reject(err);
            else resolve();
        });
    });
}

/* ===================== Echo Server ===================== */

async function serveClient(socket: net.Socket): Promise<void> {
    const conn = soInit(socket);
    const buf: DynBuf = {
        data: Buffer.alloc(0),
        size: 0,
    };

    while (true) {
        const msg = cutMessage(buf);

        if (!msg) {
            const data = await soRead(conn);
            bufPush(buf, data);

            if (data.length === 0) {
                console.log("end connection");
                break;
            }
            continue;
        }

        if (msg.equals(Buffer.from("quit\n"))) {
            await soWrite(conn, Buffer.from("Bye\n"));
            socket.destroy();
        } else {
            const reply = Buffer.concat([
                Buffer.from("Echo: "),
                msg,
            ]);
            await soWrite(conn, reply);
        }
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
        serveClient(conn.socket); // fire-and-forget
    }
}

main().catch((err) => {
    console.error("fatal:", err);
});

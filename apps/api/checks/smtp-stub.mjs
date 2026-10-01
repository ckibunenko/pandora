// Minimal in-process SMTP server for checks: accepts, fails (451 transient / 550 permanent), or hangs after DATA.
import net from "node:net";

function parseMessage(envelope, data) {
  const [head] = data.split("\n\n");
  const headers = {};
  let last;
  for (const line of head.split("\n")) {
    if (/^\s/.test(line) && last) headers[last] += ` ${line.trim()}`;
    else {
      const index = line.indexOf(":");
      last = line.slice(0, index).toLowerCase();
      headers[last] = line.slice(index + 1).trim();
    }
  }
  return { to: envelope.to, headers, data };
}

export async function startSmtpStub() {
  const messages = [];
  const sockets = new Set();
  let mode = "accept";
  let dataReceived = 0;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setEncoding("utf8");
    let buffer = "";
    let inData = false;
    let data = "";
    let envelope = { to: [] };
    const reply = (line) => socket.write(`${line}\r\n`);
    reply("220 pandora-qa-smtp ESMTP");
    socket.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (inData) {
          if (line !== ".") {
            data += `${line.startsWith("..") ? line.slice(1) : line}\n`;
            continue;
          }
          inData = false;
          dataReceived += 1;
          if (mode === "hang") return;
          if (mode === "transient") reply("451 4.3.0 Temporary QA failure");
          else if (mode === "permanent") reply("550 5.1.1 Mailbox unavailable (QA)");
          else {
            messages.push(parseMessage(envelope, data));
            reply("250 2.0.0 Queued");
          }
          data = "";
          continue;
        }
        const command = line.slice(0, 4).toUpperCase();
        if (command === "EHLO" || command === "HELO") reply("250 pandora-qa-smtp");
        else if (command === "MAIL") {
          envelope = { to: [] };
          reply("250 OK");
        } else if (command === "RCPT") {
          envelope.to.push(/<([^>]*)>/.exec(line)?.[1]);
          reply("250 OK");
        } else if (command === "DATA") {
          inData = true;
          reply("354 End data with <CR><LF>.<CR><LF>");
        } else if (command === "QUIT") {
          reply("221 Bye");
          socket.end();
        } else if (command === "RSET" || command === "NOOP") reply("250 OK");
        else reply("502 Command not implemented");
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    messages,
    get dataReceived() {
      return dataReceived;
    },
    setMode(next) {
      mode = next;
    },
    async stop() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

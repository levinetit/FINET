// DIAG (temporar): arată ce cereri sunt închise de client înainte de final.
const http = require("http");
const orig = http.Server.prototype.emit;
http.Server.prototype.emit = function (ev, req, res) {
  if (ev === "request" && res && req) {
    const t = Date.now();
    res.on("close", () => {
      if (!res.writableFinished) {
        console.error(
          `[diag] ABORTED ${req.method} ${req.url} rsc=${req.headers.rsc ?? "-"} prefetch=${req.headers["next-router-prefetch"] ?? "-"} accept=${req.headers.accept ?? "-"} after=${Date.now() - t}ms headersSent=${res.headersSent}`,
        );
      }
    });
  }
  return orig.apply(this, arguments);
};

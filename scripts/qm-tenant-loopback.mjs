// Preloaded (via --import) into the core and web-ui children of the single-container
// tenant supervisor. Neither service takes a bind address from its environment, so this
// pins every listen() that names only a port to the loopback interface. Portal is never
// loaded with this shim: it must answer on the container port.
import net from "node:net";

if (process.env.QM_LOOPBACK_ONLY === "1") {
  const host = process.env.QM_LOOPBACK_HOST || "127.0.0.1";
  const listen = net.Server.prototype.listen;
  net.Server.prototype.listen = function loopbackListen(...args) {
    const [first, second] = args;
    const portOnly = typeof first === "number" || (typeof first === "string" && /^\d+$/.test(first));
    if (portOnly && typeof second !== "string") {
      return listen.call(this, first, host, ...args.slice(1));
    }
    if (
      first !== null &&
      typeof first === "object" &&
      first.port !== undefined &&
      !first.host &&
      !first.path &&
      first.fd === undefined &&
      !first.handle
    ) {
      return listen.call(this, { ...first, host }, ...args.slice(1));
    }
    return listen.apply(this, args);
  };
}

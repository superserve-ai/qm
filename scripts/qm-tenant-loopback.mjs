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

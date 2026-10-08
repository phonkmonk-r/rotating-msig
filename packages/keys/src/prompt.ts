import { stdin, stderr } from "node:process";

/** Reads a line from the terminal without echoing it. Refuses to run without a TTY so secrets never come from a pipe by accident. */
export function readSecret(question: string): Promise<string> {
  if (!stdin.isTTY) return Promise.reject(new Error("a terminal is required to enter secrets; use --mnemonic-file instead"));
  return new Promise((resolve, reject) => {
    let input = "";
    stderr.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const done = (error?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      stderr.write("\n");
      if (error) reject(error);
      else resolve(input);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n" || char === "\u0004") return done();
        if (char === "\u0003") return done(new Error("cancelled"));
        if (char === "\u007f" || char === "\b") input = input.slice(0, -1);
        else input += char;
      }
    };
    stdin.on("data", onData);
  });
}

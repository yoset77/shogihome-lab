import crypto from "crypto";
import net from "net";
import readline from "readline";

export async function authenticateSocket(
  socket: net.Socket,
  accessToken: string,
  timeoutMs = 5000,
): Promise<readline.Interface> {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: socket });
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(authTimeout);
      callback();
    };
    const authTimeout = setTimeout(() => {
      settle(() => {
        rl.close();
        reject(new Error("Authentication timed out"));
      });
    }, timeoutMs);

    const onLine = (line: string) => {
      const msg = line.trim();
      if (msg.startsWith("auth_cram_sha256 ")) {
        const nonce = msg.substring("auth_cram_sha256 ".length).trim();
        const digest = crypto.createHmac("sha256", accessToken).update(nonce).digest("hex");
        socket.write(`auth ${digest}\n`);
      } else if (msg === "auth_ok") {
        settle(() => {
          rl.off("line", onLine);
          resolve(rl);
        });
      } else if (msg.includes("WRAPPER_ERROR:")) {
        settle(() => {
          rl.close();
          reject(new Error(msg));
        });
      } else if (msg !== "") {
        console.warn("Unexpected message during auth:", msg);
      }
    };
    rl.on("line", onLine);
    socket.once("error", (err) => {
      settle(() => {
        rl.close();
        reject(err);
      });
    });
    socket.once("close", () => {
      settle(() => {
        rl.close();
        reject(new Error("Socket closed during authentication"));
      });
    });
  });
}

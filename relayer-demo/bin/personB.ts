import bodyParser from "body-parser";
import { JsonRpcProvider, Wallet } from "ethers";
import express from "express";
import { EscrowContract__factory } from "../../packages/hardhat/typechain-types"; // adjust import paths as needed
import { IExecuteBridgingInput } from "../types/IExecuteBridgingInput";
const app = express();
const port = 3001;

app.use(bodyParser.json());

// Helper to convert Uint8Array from base64 string and vice versa
function decodeBase64ToUint8Array(base64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(base64, "base64"));
}

function encodeUint8ArrayToBase64(data: Uint8Array): string {
  return Buffer.from(data).toString("base64");
}

// Data structures to hold bridge requests and secrets
interface BridgeRequest {
  secretHash: string; // base64 encoded
  secret?: Uint8Array;
  timestamp: number;
}

const bridgeRequests = new Map<string, BridgeRequest>();

// Method 1: bridgeRequest
app.post("/executeBridging", async (req: any, res: any) => {
  try {
    console.log("/executeBridging");
    const dataObj = req.body as IExecuteBridgingInput;

    if (!dataObj) {
      return res.status(400).json({ error: "no data provided" });
    }
    const provider = new JsonRpcProvider(process.env.EVM_RPC ?? "");
    const signer = new Wallet(process.env.PERSON_B_EVM_KEY ?? "", provider);

    const escrow = EscrowContract__factory.connect(
      process.env.HTLC_EVM_CONTRACT ?? "",
      signer
    );

    const secretHashUint = new Uint8Array(
      Buffer.from(dataObj.secretHash, "base64")
    );
    const rescueDelay = 24 * 3600;

    const tx = { value: dataObj.amount };
    const secretHashHex = "0x" + Buffer.from(secretHashUint).toString("hex");
    const createTx = await escrow.create(
      dataObj.destinationToken,
      dataObj.amount,
      rescueDelay,
      secretHashHex,
      dataObj.destinationAccount,
      tx
    );
    const receipt = await createTx.wait();
    console.log("receipt", receipt);
    console.log("secretHashHex", secretHashHex);
    //console.log(await escrow.escrows(secretHashHex));
    console.log(
      "B1. Create escrow contract with secret hash and safety deposot - createTx",
      createTx
    );
    console.log("secretHashUint", Buffer.from(secretHashUint).toString("hex"));
    try {
      const response = await fetch("http://localhost:3000/confirmLocking", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secretHash: dataObj.secretHash }),
      });

      if (!response.ok) {
        const error = await response.text();
        console.error("Relayer error:", error);
      } else {
        console.log("B2. /confirmLocking - Relayer notified successfully.");
      }
    } catch (err) {
      console.error("Failed to notify relayer:", err);
    }
    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.listen(port, () => {
  console.log(`API server listening at http://localhost:${port}`);
});

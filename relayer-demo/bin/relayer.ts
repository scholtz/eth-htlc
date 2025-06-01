import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import { AlgoAmount } from "@algorandfoundation/algokit-utils/types/amount";
import {
  EscrowClient,
  getAppIdByChain,
  getBoxNameE,
  setTaker,
} from "algorand-htlc";
import algosdk, { Transaction, TransactionSigner } from "algosdk";
import bodyParser from "body-parser";
import { JsonRpcProvider, Wallet } from "ethers";
import express from "express";
import { EscrowContract__factory } from "../../packages/hardhat/typechain-types";
import { BridgingMetaData } from "../types/BridgingMetaData";
import { IExecuteBridgingInput } from "../types/IExecuteBridgingInput";
import { ShareSecret } from "../types/ShareSecret";

const app = express();
const port = 3000;

const account = algosdk.mnemonicToSecretKey(process.env.RELAY_MNEMONIC ?? "");
const transactionSigner: TransactionSigner = async (
  txnGroup: Transaction[],
  indexesToSign: number[]
): Promise<Uint8Array[]> => {
  console.log("signing", txnGroup);
  return txnGroup.map((t) => t.signTxn(account.sk));
};
var algorand = AlgorandClient.fromConfig({
  algodConfig: {
    server: process.env.ALGOD_SERVER ?? "",
    port: parseInt(process.env.ALGOD_PORT ?? "443"),
    token: process.env.ALGOD_TOKEN ?? "",
  },
  indexerConfig: {
    server: process.env.INDEXER_SERVER ?? "",
    port: parseInt(process.env.INDEXER_PORT ?? "443"),
    token: process.env.INDEXER_TOKEN ?? "",
  },
});
algorand.account.setDefaultSigner(transactionSigner);

const getClient = (
  activeAddress: string,
  transactionSigner: TransactionSigner
) => {
  if (!activeAddress) throw Error("Active address not found");
  if (!transactionSigner) throw Error("transactionSigner is missing");

  const appId = getAppIdByChain(
    (process.env.AVM_CHAIN_GENESIS as
      | "testnet-v1.0"
      | "voimain-v1.0"
      | "mainnet-v1.0"
      | "dockernet-v1") ?? "testnet-v1.0"
  );
  const client = new EscrowClient({
    algorand: algorand,
    appId: appId,
    defaultSender: activeAddress,
    defaultSigner: transactionSigner,
  });
  return client;
};

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
  state:
    | "HTLC2_CREATING"
    | "SETTING_HTLC1_TAKER"
    | "CONTRACTS_READY"
    | "PUBLIC";
}

function trimTrailingZeros(arr: Uint8Array): Uint8Array {
  let lastNonZeroIndex = -1;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] !== 0) {
      lastNonZeroIndex = i;
      break;
    }
  }
  // If all bytes are zero, return empty Uint8Array
  if (lastNonZeroIndex === -1) return new Uint8Array(0);

  return arr.slice(0, lastNonZeroIndex + 1);
}

const bridgeRequests = new Map<string, BridgeRequest>();

// Method 1: bridgeRequest
app.post("/bridgeRequest", async (req: any, res: any) => {
  try {
    console.log("/bridgeRequest");
    const { secretHash } = req.body;

    if (!secretHash) {
      return res.status(400).json({ error: "secretHash is required" });
    }

    // Decode and validate length
    const secretHashBytes = decodeBase64ToUint8Array(secretHash);
    if (secretHashBytes.length !== 32) {
      return res.status(400).json({ error: "secretHash must be 32 bytes" });
    }

    const secretHashUint = new Uint8Array(Buffer.from(secretHashBytes));

    const key = Buffer.from(secretHashUint).toString("hex"); // use hex string as key
    if (bridgeRequests.has(key)) {
      return res.status(409).json({ error: "Bridge request already exists" });
    }
    console.log("getting client");
    const client = getClient(account.addr.toString(), transactionSigner);
    console.log("fetching escrow", Buffer.from(secretHashUint).toString("hex"));
    const escrow = await client.getEscrow({
      args: { secretHash: secretHashUint },
      boxReferences: [getBoxNameE(secretHashUint)],
    });
    console.log("R1. check the funds - escrow found", escrow);
    const instructions = Buffer.from(trimTrailingZeros(escrow.memo)).toString(
      "utf8"
    );
    const metaObj = JSON.parse(instructions) as BridgingMetaData;
    console.log("instructions", instructions, metaObj);
    bridgeRequests.set(key, {
      secretHash: key,
      timestamp: Date.now(),
      state: "SETTING_HTLC1_TAKER",
    });

    console.log("fetching escrow 2", secretHashUint);
    const avmEscrow = await client.getEscrow({
      args: { secretHash: secretHashUint },
      boxReferences: [getBoxNameE(secretHashUint)],
    });
    console.log("set taker", secretHashUint);
    await setTaker({
      client: client,
      secretHash: secretHashUint,
      sender: account.addr.toString(),
      tokenId: await avmEscrow.tokenId,
      taker: process.env.PERSON_B_ADDRESS ?? "",
    });
    console.log("R2. Taker at HTLC1 set to Person B");
    bridgeRequests.set(key, {
      secretHash: key,
      timestamp: Date.now(),
      state: "HTLC2_CREATING",
    });

    const dataObj: IExecuteBridgingInput = {
      amount: escrow.amount,
      secretHash: Buffer.from(secretHashUint).toString("base64"),
      destination: metaObj.destination,
      destinationAccount: metaObj.destinationAccount,
      minimumAmount: metaObj.minimumAmount,
      destinationToken: metaObj.destinationToken,
    };

    try {
      console.log("sending to person B", dataObj);
      const response = await fetch("http://localhost:3001/executeBridging", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(dataObj, (_, v) =>
          typeof v === "bigint" ? v.toString() : v
        ),
      });

      if (!response.ok) {
        const error = await response.text();
        console.error("Person B notification error:", error);
      } else {
        console.log(
          "R3. Share secret hash with Person B with trade data - Person B notified successfully."
        );
      }
    } catch (err) {
      console.error("Failed to notify person B:", err);
    }
    res.json({ success: true });
  } catch (e) {
    console.log("error", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Method 1: bridgeRequest
app.post("/confirmLocking", async (req: any, res: any) => {
  try {
    console.log("/confirmLocking");
    const { secretHash } = req.body;

    if (!secretHash) {
      return res.status(400).json({ error: "secretHash is required" });
    }

    // Decode and validate length
    const secretHashBytes = decodeBase64ToUint8Array(secretHash);
    if (secretHashBytes.length !== 32) {
      return res.status(400).json({ error: "secretHash must be 32 bytes" });
    }
    const secretHashUint = new Uint8Array(Buffer.from(secretHashBytes));

    const key = Buffer.from(secretHashUint).toString("hex"); // use hex string as key
    if (!bridgeRequests.has(key)) {
      return res.status(409).json({ error: "Bridge request does not exists" });
    }

    const provider = new JsonRpcProvider(process.env.EVM_RPC ?? "");
    const signer = new Wallet(process.env.PERSON_B_EVM_KEY ?? "", provider);

    const escrowEthContract = EscrowContract__factory.connect(
      process.env.HTLC_EVM_CONTRACT ?? "",
      signer
    );
    console.log("secretHashUint", Buffer.from(secretHashUint).toString("hex"));
    const secretHashHex = "0x" + Buffer.from(secretHashUint).toString("hex");
    console.log("secretHashHex", secretHashHex);
    // TODO loading the escrow does not work for unknown reason
    //const HTLC2 = await escrowEthContract.escrows(secretHashHex);

    const client = getClient(account.addr.toString(), transactionSigner);
    const HTLC1 = await client.getEscrow({
      args: { secretHash: secretHashUint },
      boxReferences: [getBoxNameE(secretHashUint)],
    });
    const instructions = Buffer.from(trimTrailingZeros(HTLC1.memo)).toString(
      "utf8"
    );
    const HTLC1metaObj = JSON.parse(instructions) as BridgingMetaData;

    // if (HTLC1metaObj.destinationToken != HTLC2.tokenAddress)
    //   throw Error("Destination token does not match");
    // if (HTLC1metaObj.minimumAmount > HTLC2.amount)
    //   throw Error("Amount below desired minimum");
    // TODO more checks
    console.log("R4. check if the secret hash is in HTLC on EHT plus funds");

    bridgeRequests.set(key, {
      secretHash: key,
      timestamp: Date.now(),
      state: "CONTRACTS_READY",
    });
    console.log(`state of ${key} changed to CONTRACTS_READY`);
    res.json({ success: true });
  } catch (e) {
    console.log("error", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/checkState", async (req: any, res: any) => {
  try {
    console.log("/checkState");
    const { secretHash } = req.body;

    if (!secretHash) {
      return res.status(400).json({ error: "secretHash is required" });
    }

    // Decode and validate length
    const secretHashBytes = decodeBase64ToUint8Array(secretHash);
    if (secretHashBytes.length !== 32) {
      return res.status(400).json({ error: "secretHash must be 32 bytes" });
    }
    const secretHashUint = new Uint8Array(Buffer.from(secretHashBytes));

    const key = Buffer.from(secretHashUint).toString("hex"); // use hex string as key
    if (bridgeRequests.has(key)) {
      if (bridgeRequests.get(key)?.state === "CONTRACTS_READY") {
        return res.status(200).json({ error: "Contracts ready" });
      } else if (bridgeRequests.get(key)?.state === "PUBLIC") {
        return res.status(201).json({ error: "funds Released" });
      } else {
        return res.status(400).json({
          error:
            "Try again later, currently in state " +
            bridgeRequests.get(key)?.state,
        });
      }
    } else {
      return res.status(401).json({ error: "Hash not found" });
    }
  } catch (e) {
    console.log("error", e);
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post("/shareSecret", async (req: any, res: any) => {
  try {
    console.log("/shareSecret");
    const dataObj = req.body as ShareSecret;

    if (!dataObj) {
      return res.status(400).json({ error: "no data provided" });
    }
    const provider = new JsonRpcProvider(process.env.EVM_RPC ?? "");
    const signer = new Wallet(process.env.PERSON_B_EVM_KEY ?? "", provider);

    const escrowEthContract = EscrowContract__factory.connect(
      process.env.HTLC_EVM_CONTRACT ?? "",
      signer
    );

    const secretHashUint = new Uint8Array(
      Buffer.from(dataObj.secretHashB64, "base64")
    );
    const secretUint = new Uint8Array(Buffer.from(dataObj.secretB64, "base64"));

    const withdrawTx = await escrowEthContract.withdraw(
      secretHashUint,
      secretUint
    );
    console.log(
      "A3. DONE ONE ETH - Create escrow contract with secret hash and safety deposot - createTx",
      withdrawTx
    );

    const client = getClient(account.addr.toString(), transactionSigner);
    const avmEscrow = await client.getEscrow({
      args: { secretHash: secretHashUint },
    });

    await client.send.withdraw({
      args: {
        secret: secretUint,
        secretHash: secretHashUint,
      },
      staticFee: AlgoAmount.MicroAlgo(3000),
    });

    // await claimFromEscrow({
    //   client: client,
    //   secret: secretUint,
    //   secretHash: secretHashUint,
    //   sender: account.addr.toString(),
    //   tokenId: await avmEscrow.tokenId,
    // });

    const key = Buffer.from(secretHashUint).toString("hex"); // use hex string as key
    bridgeRequests.set(key, {
      secretHash: key,
      timestamp: Date.now(),
      state: "PUBLIC",
    });

    res.json({ success: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Internal server error" });
  }
});
app.listen(port, () => {
  console.log(`API server listening at http://localhost:${port}`);
});

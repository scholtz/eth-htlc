// person A creates escrow and notifies the relayer with the hash, then periodically tries to fetch the info if he can reveal the secret, and if true he calls the method
import { AlgorandClient } from "@algorandfoundation/algokit-utils";
import { createEscrow, EscrowClient } from "algorand-htlc";
import algosdk, { Transaction, TransactionSigner } from "algosdk";
import crypto from "crypto";
import { setTimeout } from "timers/promises";
import { BridgingMetaData } from "../types/BridgingMetaData";
import { ShareSecret } from "../types/ShareSecret";

const account = algosdk.mnemonicToSecretKey(
  process.env.PERSSON_A_MNEMONIC ?? ""
);
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

  const client = new EscrowClient({
    algorand: algorand,
    appId: 5247n,
    defaultSender: activeAddress,
    defaultSigner: transactionSigner,
  });
  return client;
};

const secret = new Uint8Array(50);
crypto.getRandomValues(secret);

const avmClient = getClient(account.addr.toString(), transactionSigner);
const addMoneyToHTLC = async () => {
  const hash = await avmClient.makeHash({ args: { secret: secret } });
  if (!process.env.RELAY_ADDRESS)
    throw Error("process.env.RELAY_ADDRESS is empty");
  const brigingMeta: BridgingMetaData = {
    destination: "base",
    destinationAccount: "0xcd3B766CCDd6AE721141F452C550Ca635964ce71",
    destinationToken: "0x0000000000000000000000000000000000000000",
    minimumAmount: 1000,
  };
  await createEscrow({
    client: avmClient,
    deposit: 1_000_000n,
    destinationSetter: process.env.RELAY_ADDRESS,
    memo: new Uint8Array(
      Buffer.from(
        JSON.stringify(brigingMeta, (_, v) =>
          typeof v === "bigint" ? v.toString() : v
        ),
        "ascii"
      )
    ),
    rescueDelay: 24n * 3600n,
    secretHash: hash,
    sender: account.addr.toString(),
    taker: process.env.RELAY_ADDRESS,
    tokenId: 0n,
    tokenType: "native",
  });
  console.log("A1. move funds to HTLC1. ", Buffer.from(hash).toString("hex"));
};
const notifyRelayer = async () => {
  const secretHash = await avmClient.makeHash({ args: { secret: secret } });
  const base64SecretHash = Buffer.from(secretHash).toString("base64");

  try {
    const response = await fetch("http://localhost:3000/bridgeRequest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secretHash: base64SecretHash }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error("Relayer error:", error);
    } else {
      console.log("Relayer notified successfully.");
    }

    console.log("A2. Share secret hash with relayer");
  } catch (err) {
    console.error("Failed to notify relayer:", err);
  }
};

// Periodic check for all in-progress bridge requests (every 10 seconds)
const checkRequest = async () => {
  const secretHash = await avmClient.makeHash({ args: { secret: secret } });
  const base64SecretHash = Buffer.from(secretHash).toString("base64");
  while (true) {
    try {
      const response = await fetch("http://localhost:3000/checkState", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secretHash: base64SecretHash }),
      });
      if (response.status == 201) {
        console.log("Release of funds has been processed");
        return true;
      }
      if (response.status == 200) {
        console.log("We can continue with making the secret public");

        const dataObj: ShareSecret = {
          secretB64: Buffer.from(secret).toString("base64"),
          secretHashB64: base64SecretHash,
        };
        try {
          console.log("sending to relay the secret", dataObj);
          const response = await fetch("http://localhost:3000/shareSecret", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(dataObj, (_, v) =>
              typeof v === "bigint" ? v.toString() : v
            ),
          });

          if (!response.ok) {
            const error = await response.text();
            console.error("Relay notification error:", error);
          } else {
            console.log("A3. secret shared");
          }
        } catch (err) {
          console.error("Failed to notify relayer:", err);
        }
      } else {
        console.log("Status: " + response.status);
      }
    } catch (err) {
      console.error("Failed to notify relayer:", err);
    }

    console.log("A3 not ready. Checking my bridge request in progress...");
    await setTimeout(3000);
  }
};

const run = async () => {
  console.log("Person A address: ", account.addr.toString());
  await addMoneyToHTLC();
  await notifyRelayer();
  await checkRequest();
};

run();

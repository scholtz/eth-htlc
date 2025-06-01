export interface IExecuteBridgingInput {
  secretHash: string;
  amount: bigint;
  destination: "base" | "arbitrum" | "algorand" | "voi";
  destinationAccount: string;
  destinationToken: string;
  minimumAmount: number;
}

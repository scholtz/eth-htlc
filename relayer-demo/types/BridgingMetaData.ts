export interface BridgingMetaData {
  destination: "base" | "arbitrum" | "algorand" | "voi";
  destinationAccount: string;
  destinationToken: string;
  minimumAmount: number;
}

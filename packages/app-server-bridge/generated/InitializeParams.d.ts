import type { ClientInfo } from "./ClientInfo";
import type { InitializeCapabilities } from "./InitializeCapabilities";
export type InitializeParams = {
    clientInfo: ClientInfo;
    capabilities: InitializeCapabilities | null;
};

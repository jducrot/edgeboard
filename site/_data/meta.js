import { nowEtLabel, slateDateEt } from "../../lib/espn.mjs";

// The server sets globalThis.edgeboardStatus before each build. Building
// outside the server (npx @11ty/eleventy) treats the build time as the
// download time.
export default function () {
  const status = globalThis.edgeboardStatus;
  const lastOnline = status?.lastOnlineAt ? new Date(status.lastOnlineAt) : new Date();
  return {
    dataAsOfEt: nowEtLabel(lastOnline),
    todayYmd: slateDateEt(0),
  };
}

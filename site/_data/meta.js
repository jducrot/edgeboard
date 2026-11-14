import { nowEtLabel, slateDateEt } from "../../lib/espn.mjs";

export default function () {
  return {
    builtAtEt: nowEtLabel(),
    todayYmd: slateDateEt(0),
  };
}

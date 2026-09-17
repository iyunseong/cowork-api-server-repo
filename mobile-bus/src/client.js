// Operator factory for the bus app. Both clients share the interface the
// macro engine drives: login (no-op), searchTrain, reserve, findTrainById,
// buildTrainId, makePassengers.

import { Kobus } from "./bus/kobus.js";
import { Tmoney } from "./bus/tmoney.js";
import { KOBUS_TERMINALS, TMONEY_TERMINALS } from "./bus/terminals.js";

export const OPERATORS = {
  kobus: { label: "고속버스 (코버스)", codeDigits: 3, terminals: KOBUS_TERMINALS },
  tmoney: { label: "시외버스 (티머니)", codeDigits: 7, terminals: TMONEY_TERMINALS },
};

export function createClient(operator, http) {
  return operator === "tmoney" ? new Tmoney(http) : new Kobus(http);
}

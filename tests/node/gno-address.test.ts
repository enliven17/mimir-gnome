import assert from "node:assert/strict";
import test from "node:test";

import { realmAddress } from "../../lib/gno/address";

// Values printed by chain.PackageAddress in a gno test.
test("realm addresses match chain.PackageAddress", () => {
  const ns = "g12dcsmwccgdxasqde2eumua88tlrkw83kqf6tcz";
  assert.equal(realmAddress(`gno.land/r/${ns}/pool`), "g15s5wce4jrntmlvwww3ct84xfxdavtvfrm3sz6x");
  assert.equal(realmAddress(`gno.land/r/${ns}/vs`), "g1lla0fveljx953zky47hpuu0zguzp5cassl28vh");
  assert.equal(realmAddress(`gno.land/r/${ns}/agentpay`), "g186afur36qzagt3tp969lsnx0rzlfhm4egqyktf");
});

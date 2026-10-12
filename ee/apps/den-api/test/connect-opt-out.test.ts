import assert from "node:assert/strict"
import { test } from "node:test"

process.env.DATABASE_URL ??= "mysql://test:test@127.0.0.1:3306/connect_opt_out_unit_test"
process.env.BETTER_AUTH_URL ??= "http://unit.test"
process.env.BETTER_AUTH_SECRET ??= "synthetic-connect-opt-out-unit-test-secret"
process.env.DEN_DB_ENCRYPTION_KEY ??= "synthetic-connect-opt-out-unit-test-encryption-key"
process.env.OPENWORK_DEV_MODE ??= "1"
const { resolveLegacyConnectState } = await import("../src/connect-opt-out.js")

test("Connect is available when nothing was stored", () => {
  assert.equal(resolveLegacyConnectState({ rollout: null, lock: null, override: null }), true)
})

test("an organization that turned Connect off keeps it off", () => {
  assert.equal(resolveLegacyConnectState({ rollout: null, lock: null, override: false }), false)
  assert.equal(resolveLegacyConnectState({ rollout: { enabled: true, killed: false }, lock: null, override: false }), false)
})

test("an organization override outranks the deployment-wide state", () => {
  assert.equal(resolveLegacyConnectState({ rollout: { enabled: false, killed: false }, lock: null, override: true }), true)
  assert.equal(resolveLegacyConnectState({ rollout: { enabled: false, killed: false }, lock: null, override: null }), false)
})

test("the operator lock outranks the organization override", () => {
  assert.equal(resolveLegacyConnectState({ rollout: null, lock: true, override: false }), true)
  assert.equal(resolveLegacyConnectState({ rollout: null, lock: false, override: true }), false)
})

test("the kill switch outranks everything", () => {
  assert.equal(resolveLegacyConnectState({ rollout: { enabled: true, killed: true }, lock: true, override: true }), false)
})

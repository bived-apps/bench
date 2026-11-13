// Series builder for the progressive delegate benchmark (administrator side). Pure and offline: it returns the
// manifest and the fixtures, and writes, persists or prints nothing. There is no command line in this part.
// The manifest is not a release: run_ready and qualifies stay false in every part until the protocol, isolation and
// owner gates are passed. A hash here is not a signature and does not prove that the hidden key was isolated.
import { createHash, createHmac } from "node:crypto";
import { FAMILY_IDS, IMPLEMENTED_FAMILY_IDS, createFixture, validateSeed } from "./fixtures.mjs";
import { createControls } from "./controls.mjs";

export const CRITERIA_ID = "delegate-minima-20261113-B";

const OPTION_NAMES = new Set(["seed", "allowPartial"]);
const SCHEDULED_FAMILIES = FAMILY_IDS.length;

// Stable JSON: sorted keys, no non-finite numbers, no undefined; a value that is not JSON throws.
export function canonicalJson(value) {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("canonicalJson: non-finite number");
      return JSON.stringify(value);
    case "object":
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
      return `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
        .join(",")}}`;
    default:
      throw new TypeError(`canonicalJson: not JSON (${typeof value})`);
  }
}

function sha256Hex(text) {
  return createHash("sha256").update(text).digest("hex");
}

// The key is derived from the seed, which stays with the administrator: commitments under it are not public proof.
function seriesKey(seed) {
  return createHash("sha256").update(`bive-progressive-series-key-v1\u0000${seed}`).digest();
}

function keyed(key, text) {
  return createHmac("sha256", key).update(text).digest("hex");
}

export function buildSeries(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("buildSeries takes an options object");
  }
  for (const name of Object.keys(options)) {
    if (!OPTION_NAMES.has(name)) throw new TypeError(`unknown option: ${name}`);
  }
  const { seed, allowPartial = false } = options;
  validateSeed(seed);
  if (typeof allowPartial !== "boolean") throw new TypeError("allowPartial must be a boolean");

  const missing = FAMILY_IDS.filter((familyId) => !IMPLEMENTED_FAMILY_IDS.includes(familyId));
  if (missing.length > 0 && !allowPartial) {
    throw new Error(
      `incomplete series refused: ${missing.length} of ${SCHEDULED_FAMILIES} families are not generated in this part; ` +
        "allowPartial: true gives development material only",
    );
  }

  const key = seriesKey(seed);
  const fixtures = IMPLEMENTED_FAMILY_IDS.map((familyId) => {
    const fixture = createFixture(familyId, seed);
    return { ...fixture, admin: { ...fixture.admin, controls: createControls(fixture) } };
  });

  const slots = fixtures.map((fixture) => ({
    slot_id: fixture.slot_id,
    family_hmac_sha256: keyed(key, `family\u0000${fixture.family_id}`),
    material_hmac_sha256: keyed(key, `material\u0000${canonicalJson(fixture)}`),
  }));

  const manifest = {
    schema_v: 1,
    mode: "development",
    criteria_id: CRITERIA_ID,
    series_id: `series-${keyed(key, "series-id").slice(0, 24)}`,
    scheduled_families: SCHEDULED_FAMILIES,
    generated_families: IMPLEMENTED_FAMILY_IDS.length,
    missing_families: missing,
    incomplete: missing.length > 0,
    run_ready: false,
    qualifies: false,
    private_commitments: {
      algorithm: "HMAC-SHA256 under a key derived from the seed",
      series_sha256: sha256Hex(canonicalJson(slots)),
      slots,
    },
    note: "Development material: not run-ready, not qualifying; the commitments are not a signature.",
  };

  return { manifest, fixtures };
}

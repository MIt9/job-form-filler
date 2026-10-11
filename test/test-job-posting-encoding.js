const assert = require("assert");
const { getJobPosting } = require("../server/job-posting");

console.log("▶ Testing percent-encoded company slugs (Ashby 'solana%20foundation')...");

(async () => {
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(String(url));
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      url: String(url),
      json: async () => ({
        jobs: [{ id: "4a3cefc1-82c3-4e6b-a7b6-44f9d087c45a", title: "Lead Engineer", location: "Remote-Europe", isRemote: true, descriptionPlain: "Build things.\n\nRequirements\n- TypeScript" }]
      })
    };
  };
  const res = await getJobPosting("https://jobs.ashbyhq.com/solana%20foundation/4a3cefc1-82c3-4e6b-a7b6-44f9d087c45a", { fetchImpl });
  assert.strictEqual(res.title, "Lead Engineer");
  assert(requested[0].includes("/job-board/solana%20foundation?"), `single-encoded slug expected, got ${requested[0]}`);
  assert(!requested[0].includes("%2520"), "slug must not be double-encoded");
  console.log("✔ Encoded slug tests passed!");
})().catch((e) => { console.error(e); process.exit(1); });

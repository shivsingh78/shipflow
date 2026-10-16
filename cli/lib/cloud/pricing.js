// Approximate cost shown on the review screen.
//
// These are transcribed from AWS's public price data and can be out of date:
// they are an estimate for deciding, never a billing guarantee. Regions and
// instance types not listed here get no estimate (a link is shown instead)
// rather than a guess.
//
//   EC2 on-demand Linux and public IPv4 rates: AWS pricing feeds published
//   2026-10-15 (EC2) and 2026-09-17 (VPC), fetched 2026-10-15.
//   EBS gp3: the feed's EBS section lists 0.0912 for Mumbai but does not label
//   it, and AWS's EBS pricing page publishes no per-region figure, so this one
//   number is an unverified assumption and is labelled as such.
export const PRICING_VERIFIED_AT = "2026-10-15";
export const PRICING_URL = "https://aws.amazon.com/ec2/pricing/on-demand/";
export const HOURS_PER_MONTH = 730;

const TABLE = {
  "ap-south-1": {
    label: "Asia Pacific (Mumbai)",
    instanceHourly: {
      "t3.nano": 0.0056,
      "t3.micro": 0.0112,
      "t3.small": 0.0224,
      "t3.medium": 0.0448,
    },
    publicIpv4Hourly: 0.005,
    gp3PerGibMonth: 0.0912,
    gp3Verified: false,
  },
};

const round = (value) => Math.round(value * 10000) / 10000;

/**
 * @returns {{ lines, hourly, monthly, complete, verifiedAt, url, notes }}
 */
export function estimateCost({ region, instanceType, diskGiB, publicIp = true }) {
  const prices = TABLE[region];
  const lines = [];
  const notes = [];

  if (!prices) {
    return {
      lines,
      hourly: null,
      monthly: null,
      complete: false,
      verifiedAt: PRICING_VERIFIED_AT,
      url: PRICING_URL,
      notes: [`No built-in price table for ${region}; see ${PRICING_URL}`],
    };
  }

  const add = (label, hourly, basis) =>
    lines.push({ label, hourly: round(hourly), monthly: round(hourly * HOURS_PER_MONTH), basis });

  const instance = prices.instanceHourly[instanceType];

  if (instance !== undefined) {
    add(`EC2 ${instanceType} (Linux, on-demand)`, instance, "AWS price feed");
  } else {
    notes.push(`No built-in price for ${instanceType} in ${region}; see ${PRICING_URL}`);
  }

  if (publicIp) {
    add("Public IPv4 address (in use)", prices.publicIpv4Hourly, "AWS price feed");
  }

  add(
    `EBS gp3 ${diskGiB} GiB`,
    (diskGiB * prices.gp3PerGibMonth) / HOURS_PER_MONTH,
    prices.gp3Verified ? "AWS price feed" : "UNVERIFIED assumption"
  );

  const hourly = round(lines.reduce((sum, line) => sum + line.hourly, 0));
  const monthly = round(lines.reduce((sum, line) => sum + line.monthly, 0));

  return {
    lines,
    hourly,
    monthly,
    complete: instance !== undefined,
    verifiedAt: PRICING_VERIFIED_AT,
    url: PRICING_URL,
    notes,
  };
}

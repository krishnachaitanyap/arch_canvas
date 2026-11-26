import { describe, expect, it } from "vitest";
import { bestIcon, guessFamily, normalizeIconName, parseIconRef, sanitizeIconData, sanitizeSvg } from "../src/index.js";

describe("icon matching", () => {
  it("normalises vendor file names", () => {
    expect(normalizeIconName("Cloud-Run_512-color.svg")).toBe("cloud run");
    expect(normalizeIconName("AmazonSageMakerAI")).toBe("amazon sage maker ai");
    expect(normalizeIconName("cloud_sql")).toBe("cloud sql");
  });

  it("finds the best icon for a query", () => {
    const gcp = [
      { n: "Cloud-Run", t: "Cloud Run" },
      { n: "Cloud-Run-for-Anthos", t: "Cloud Run for Anthos" },
      { n: "Cloud-SQL", t: "Cloud SQL" },
      { n: "Cloud-Storage", t: "Cloud Storage" },
      { n: "Pub-Sub", t: "Pub/Sub" },
    ];
    expect(bestIcon("cloud run", gcp)?.n).toBe("Cloud-Run");
    expect(bestIcon("pubsub", gcp)?.n).toBe("Pub-Sub");
    expect(bestIcon("cloud storage", gcp)?.n).toBe("Cloud-Storage");
    expect(bestIcon("kubernetes", gcp)).toBeUndefined();
    const aws = [
      { n: "AmazonSageMaker", t: "AmazonSageMaker" },
      { n: "AmazonSageMakerAI", t: "Amazon SageMaker" },
      { n: "AmazonSageMakerGroundTruth", t: "Amazon SageMaker Ground Truth" },
      { n: "AWSLambda", t: "AWS Lambda" },
    ];
    expect(bestIcon("sagemaker", aws)?.n).toMatch(/^AmazonSageMaker(AI)?$/);
    expect(bestIcon("lambda", aws)?.n).toBe("AWSLambda");
  });

  it("parses references and guesses pack families", () => {
    expect(parseIconRef("aws:AWSLambda")).toEqual({ pack: "aws", name: "AWSLambda" });
    expect(parseIconRef("gcp~cloud run")).toEqual({ family: "gcp", name: "cloud run" });
    expect(parseIconRef("nothing")).toBeNull();
    expect(guessFamily("Google Cloud icons.zip")).toBe("gcp");
    expect(guessFamily("Asset-Package_AWS.zip")).toBe("aws");
  });
});

describe("SVG sanitising", () => {
  it("strips scripts, handlers, foreignObject and external links", () => {
    const bad = `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script><foreignObject><div/></foreignObject><a href="javascript:alert(3)"><rect onclick='x()' width="1"/></a><image href="https://evil.example/x.png"/></svg>`;
    const out = sanitizeSvg(bad)!;
    expect(out).not.toMatch(/script|onload|onclick|foreignObject|javascript:|evil\.example/i);
    expect(out).toMatch(/^<svg/);
    expect(out).toContain('<rect width="1"/>');
  });

  it("accepts PNG data URLs and rejects other content", () => {
    expect(sanitizeIconData("data:image/png;base64,iVBORw0KGgo=")).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(sanitizeIconData("data:text/html;base64,PHNjcmlwdD4=")).toBeNull();
    expect(sanitizeIconData("<html><body/></html>")).toBeNull();
  });
});

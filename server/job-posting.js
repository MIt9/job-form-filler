/**
 * Job Posting Fetcher, Normalizer & Aggregator Resolver
 * Fetches job postings server-side from ATS APIs (Ashby, Greenhouse, Lever, Workable),
 * resolves aggregator tracker links (startup.jobs, welcometothejungle, bebee, jobijoba, linkedin, dou.ua),
 * and provides summary mode screening with geo hints extraction.
 */

const ENTITY_MAP = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
  "&nbsp;": " ",
  "&mdash;": "—",
  "&ndash;": "–",
  "&bull;": "•",
  "&middot;": "·",
  "&rsquo;": "’",
  "&lsquo;": "‘",
  "&rdquo;": "”",
  "&ldquo;": "“",
  "&hellip;": "…",
  "&copy;": "©",
  "&reg;": "®",
  "&trade;": "™",
  "&euro;": "€",
  "&pound;": "£",
  "&yen;": "¥",
  "&sect;": "§"
};

function decodeHtmlEntities(text) {
  if (!text || typeof text !== "string") return "";
  return text
    .replace(/&#(\d+);/g, (_, code) => {
      try {
        return String.fromCodePoint(parseInt(code, 10));
      } catch {
        return "";
      }
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => {
      try {
        return String.fromCodePoint(parseInt(code, 16));
      } catch {
        return "";
      }
    })
    .replace(/&[a-zA-Z]+;/g, (match) => ENTITY_MAP[match] || match);
}

function htmlToPlainText(html) {
  if (!html || typeof html !== "string") return "";
  let text = html;
  // Remove scripts, styles, noscript, svg
  text = text.replace(/<(script|style|noscript|svg)[^>]*>[\s\S]*?<\/\1>/gi, "");
  // Replace <br> and <hr> with newlines
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<hr\s*\/?>/gi, "\n\n");
  // Replace <li> with bullet point
  text = text.replace(/<li[^>]*>/gi, "\n• ");
  // Block tags to double newlines
  text = text.replace(/<\/(p|div|h[1-6]|ul|ol|table|tr|section|article|blockquote)>/gi, "\n\n");
  // Strip all other HTML tags
  text = text.replace(/<[^>]+>/g, "");
  // Decode entities
  text = decodeHtmlEntities(text);
  // Normalize whitespace
  text = text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text;
}

function extractRequirements(descriptionText) {
  if (!descriptionText || typeof descriptionText !== "string") return null;
  const lines = descriptionText.split("\n");
  let startIndex = -1;
  let endIndex = -1;

  const reqHeadingRegex = /^(?:[#*_\s-]*)(?:(?:basic|minimum|key|role|core|job)\s+)?(?:requirements|qualifications)|must[- ]haves?|the profile\b|what you(?:'ll| will)? (?:bring|need)|what we(?:'re| are)? looking for|who you are|skills (?:&|and) experience/i;
  const nextHeadingRegex = /^(?:[#*_\s-]*)(?:(?:preferred|bonus|nice to have)\s+(?:qualifications|skills)?|benefits|what we offer|perks|compensation|about (?:us|the team|the company)|responsibilities|what you(?:'ll| will)? do|how (?:to apply|we hire)|interview process|equal opportunity)/i;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (startIndex === -1) {
      if (reqHeadingRegex.test(line) && line.length < 80) {
        startIndex = i;
      }
    } else {
      if (nextHeadingRegex.test(line) && line.length < 80) {
        endIndex = i;
        break;
      }
    }
  }

  if (startIndex !== -1) {
    const sectionLines = endIndex !== -1 ? lines.slice(startIndex, endIndex) : lines.slice(startIndex);
    const text = sectionLines.join("\n").trim();
    return text || null;
  }
  return null;
}

function isPrivateHost(hostname) {
  if (!hostname || typeof hostname !== "string") return true;
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    return true;
  }
  if (host === "::1" || host === "::" || host === "0.0.0.0") {
    return true;
  }
  // IPv6 link-local (fe80::/10) or unique local (fc00::/7)
  if (/^fe[89ab][0-9a-f]:/i.test(host) || /^f[cd][0-9a-f]{2}:/i.test(host)) {
    return true;
  }
  // Check IPv4 dotted-quad
  const ipv4Match = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4Match) {
    const [_, a, b, c, d] = ipv4Match.map(Number);
    if (a === 127) return true; // 127.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local)
    if (a === 0) return true; // 0.0.0.0/8
  }
  return false;
}

function validateUrl(url) {
  if (!url || typeof url !== "string") {
    throw new Error("Invalid URL: URL must be a non-empty string");
  }
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch (err) {
    throw new Error(`Invalid URL: ${err.message}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Invalid URL protocol "${parsed.protocol}". Only http: and https: URLs are allowed.`);
  }
  return parsed;
}

function isAggregatorHost(parsedUrl) {
  const host = parsedUrl.hostname.toLowerCase();
  const path = parsedUrl.pathname.toLowerCase();
  if (host === "startup.jobs" || host.endsWith(".startup.jobs")) return true;
  if (host === "welcometothejungle.com" || host.endsWith(".welcometothejungle.com")) return true;
  if (host === "bebee.com" || host.endsWith(".bebee.com")) return true;
  if (host === "jobijoba" || /(?:^|\.)jobijoba\.[a-z]+$/i.test(host)) return true;
  if ((host === "linkedin.com" || host.endsWith(".linkedin.com")) && (path === "/jobs" || path.startsWith("/jobs/"))) return true;
  return false;
}

function isDouHost(parsedUrl) {
  const host = parsedUrl.hostname.toLowerCase();
  return host === "jobs.dou.ua" || host === "dou.ua" || host.endsWith(".dou.ua");
}

function isKnownAtsHost(hostname) {
  if (!hostname || typeof hostname !== "string") return false;
  const host = hostname.toLowerCase();
  const atsDomains = [
    "ashbyhq.com",
    "greenhouse.io",
    "lever.co",
    "workable.com",
    "teamtailor.com",
    "recruitee.com",
    "smartrecruiters.com",
    "breezy.hr",
    "bamboohr.com",
    "applytojob.com"
  ];
  for (const domain of atsDomains) {
    if (host === domain || host.endsWith("." + domain)) return true;
  }
  if (/(?:^|\.)personio\.[a-z]+$/i.test(host)) return true;
  return false;
}

function detectAdapter(parsedUrl) {
  const host = parsedUrl.hostname.toLowerCase();
  if (host === "jobs.ashbyhq.com" || host.endsWith(".ashbyhq.com")) {
    return "ashby";
  }
  if (host.endsWith("greenhouse.io")) {
    return "greenhouse";
  }
  if (host.endsWith("lever.co")) {
    return "lever";
  }
  if (host.endsWith("workable.com")) {
    return "workable";
  }
  return "generic";
}

function extractGeoHints(descriptionText) {
  if (!descriptionText || typeof descriptionText !== "string") return [];
  const geoRegex = /\b(?:locations?|time\s*zones?|timezones?|based in|eligible|eligibility|authori[sz]ations?|work permits?|visas?|residen(?:t|ce)s?|must (?:live|reside)|EU only|UK only|US only|CET|EST|PST|countr(?:y|ies))\b/i;

  const rawSegments = descriptionText
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((s) => s.replace(/^[\s•*-]+/, "").trim())
    .filter(Boolean);

  const hints = [];
  const seen = new Set();

  for (const seg of rawSegments) {
    if (geoRegex.test(seg)) {
      const sentence = seg.length > 200 ? seg.slice(0, 200).trim() : seg;
      const key = sentence.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        hints.push(sentence);
        if (hints.length === 6) break;
      }
    }
  }

  return hints;
}

function findOutboundAtsLink(html, baseUrl) {
  if (!html || typeof html !== "string") return null;

  function checkCandidate(candidate) {
    if (!candidate || typeof candidate !== "string") return null;
    try {
      const u = new URL(candidate.trim(), baseUrl);
      if ((u.protocol === "http:" || u.protocol === "https:") &&
          isKnownAtsHost(u.hostname) &&
          !isPrivateHost(u.hostname)) {
        return u.href;
      }
    } catch {}
    return null;
  }

  // 1. JSON-LD scripts
  const jsonLdRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = jsonLdRegex.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      const items = Array.isArray(parsed) ? parsed : (Array.isArray(parsed["@graph"]) ? parsed["@graph"] : [parsed]);
      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        if (item.potentialAction) {
          const actions = Array.isArray(item.potentialAction) ? item.potentialAction : [item.potentialAction];
          for (const act of actions) {
            if (!act) continue;
            const targetUrl = typeof act.target === "string" ? act.target : (act.target?.urlTemplate || act.target?.url || act.url);
            const found = checkCandidate(targetUrl);
            if (found) return found;
          }
        }
        if (item.directApply) {
          const found = checkCandidate(typeof item.directApply === "string" ? item.directApply : item.directApply.url);
          if (found) return found;
        }
        if (item.applyUrl) {
          const found = checkCandidate(item.applyUrl);
          if (found) return found;
        }
        if (item.url) {
          const found = checkCandidate(item.url);
          if (found) return found;
        }
        if (item.hiringOrganization?.sameAs) {
          const sameAs = Array.isArray(item.hiringOrganization.sameAs)
            ? item.hiringOrganization.sameAs
            : [item.hiringOrganization.sameAs];
          for (const s of sameAs) {
            const found = checkCandidate(s);
            if (found) return found;
          }
        }
      }
    } catch {}
  }

  // 2. href attributes in HTML
  const hrefRegex = /href=["']([^"'#][^"']*)["']/gi;
  while ((match = hrefRegex.exec(html)) !== null) {
    const candidate = decodeHtmlEntities(match[1]);
    const found = checkCandidate(candidate);
    if (found) return found;
  }

  return null;
}

async function resolveApplyUrl(url, { fetchImpl = fetch } = {}) {
  const originalUrl = url.trim();
  let currentUrl = originalUrl;
  let parsed = validateUrl(currentUrl);

  if (isPrivateHost(parsed.hostname)) {
    throw new Error(`Refused: private IP or disallowed host "${parsed.hostname}"`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);

  let redirectCount = 0;
  let finalRes = null;
  let html = "";

  try {
    while (redirectCount <= 5) {
      const res = await fetchImpl(currentUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        },
        redirect: "follow",
        signal: controller.signal
      });

      const isRedirect = res.status >= 300 && res.status < 400;
      const location = res.headers?.get ? res.headers.get("location") : (res.headers?.location || res.headers?.Location || null);

      if (isRedirect && location) {
        redirectCount++;
        if (redirectCount > 5) {
          throw new Error("Too many redirects (max 5 allowed)");
        }
        let nextUrlObj;
        try {
          nextUrlObj = new URL(location, currentUrl);
        } catch (err) {
          throw new Error(`Invalid redirect URL "${location}": ${err.message}`);
        }
        if (nextUrlObj.protocol !== "http:" && nextUrlObj.protocol !== "https:") {
          throw new Error(`Refused redirect to non-http(s) protocol "${nextUrlObj.protocol}"`);
        }
        if (isPrivateHost(nextUrlObj.hostname)) {
          throw new Error(`Refused redirect to private IP or disallowed host "${nextUrlObj.hostname}"`);
        }
        currentUrl = nextUrlObj.href;
        continue;
      }

      if (res.url && typeof res.url === "string") {
        let resUrlObj;
        try {
          resUrlObj = new URL(res.url);
        } catch (err) {
          throw new Error(`Invalid response URL "${res.url}": ${err.message}`);
        }
        if (resUrlObj.protocol !== "http:" && resUrlObj.protocol !== "https:") {
          throw new Error(`Refused redirect to non-http(s) protocol "${resUrlObj.protocol}"`);
        }
        if (isPrivateHost(resUrlObj.hostname)) {
          throw new Error(`Refused redirect to private IP or disallowed host "${resUrlObj.hostname}"`);
        }
        currentUrl = res.url;
      }

      finalRes = res;
      break;
    }

    if (redirectCount > 5) {
      throw new Error("Too many redirects (max 5 allowed)");
    }

    if (!finalRes) {
      throw new Error(`Failed to fetch ${url}`);
    }

    const finalParsed = new URL(currentUrl);
    const hostChanged = finalParsed.hostname.toLowerCase() !== parsed.hostname.toLowerCase();

    if (isKnownAtsHost(finalParsed.hostname)) {
      return {
        resolvedFrom: originalUrl,
        url: currentUrl,
        resolved: true
      };
    }

    if (typeof finalRes.text === "function") {
      html = await finalRes.text();
    }

    const isAgg = isAggregatorHost(finalParsed);
    const isDou = isDouHost(finalParsed);

    if (isAgg || isDou || isAggregatorHost(parsed)) {
      const atsLink = findOutboundAtsLink(html, currentUrl);
      if (atsLink) {
        return {
          resolvedFrom: originalUrl,
          url: atsLink,
          resolved: true
        };
      }
      return {
        resolvedFrom: originalUrl,
        url: isDou ? currentUrl : originalUrl,
        resolved: false,
        html
      };
    }

    if (hostChanged) {
      return {
        resolvedFrom: originalUrl,
        url: currentUrl,
        resolved: true,
        html
      };
    }

    return {
      resolvedFrom: originalUrl,
      url: originalUrl,
      resolved: false,
      html
    };
  } catch (err) {
    if (err.name === "AbortError" || controller.signal.aborted) {
      throw new Error(`Request timed out after 20s for ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithTimeout(url, fetchImpl, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetchImpl(url, {
      ...options,
      signal: controller.signal
    });
    return res;
  } catch (err) {
    if (err.name === "AbortError" || controller.signal.aborted) {
      throw new Error(`Request timed out after 20s for ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// URL pathnames arrive percent-encoded ("solana%20foundation"); decode once so encodeURIComponent below does not double-encode.
function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

async function fetchAshbyPosting(parsedUrl, fetchImpl) {
  const segments = parsedUrl.pathname.split("/").filter(Boolean).map(safeDecode);
  const company = segments[0];
  const jobId = segments[1];
  if (!company || !jobId) {
    throw new Error(`Invalid Ashby URL "${parsedUrl.href}": expected jobs.ashbyhq.com/{company}/{jobId}`);
  }

  const apiUrl = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(company)}?includeCompensation=true`;
  const res = await fetchWithTimeout(apiUrl, fetchImpl);
  if (!res.ok) {
    throw new Error(`Ashby API error: HTTP ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  const jobs = Array.isArray(data.jobs) ? data.jobs : [];
  const job = jobs.find(
    (j) =>
      j.id === jobId ||
      (j.jobUrl && j.jobUrl.includes(jobId)) ||
      (j.applyUrl && j.applyUrl.includes(jobId))
  );

  if (!job) {
    throw new Error(`Job posting not found for ID "${jobId}" at Ashby company "${company}"`);
  }

  let descriptionText = "";
  if (job.descriptionHtml) {
    descriptionText = htmlToPlainText(job.descriptionHtml);
  } else if (job.descriptionPlain) {
    descriptionText = job.descriptionPlain.trim();
  }

  const requirementsText = extractRequirements(descriptionText);
  const companyName = company.charAt(0).toUpperCase() + company.slice(1);

  let remote = null;
  if (typeof job.isRemote === "boolean") {
    remote = job.isRemote;
  } else if (job.workplaceType) {
    remote = /remote/i.test(job.workplaceType);
  }

  const compensation =
    job.compensationTierSummary ||
    job.compensation?.compensationTierSummary ||
    (typeof job.compensation === "string" ? job.compensation : null) ||
    data.compensation?.compensationTierSummary ||
    null;

  return {
    source: "ashby",
    url: job.jobUrl || parsedUrl.href,
    title: job.title || "",
    company: companyName,
    location: job.location || (job.secondaryLocations?.[0]?.location) || "",
    remote,
    compensation,
    descriptionText,
    requirementsText,
    questions: Array.isArray(job.questions) ? job.questions : [],
    fetchedAt: new Date().toISOString()
  };
}

async function fetchGreenhousePosting(parsedUrl, fetchImpl) {
  let boardToken = null;
  let jobId = null;

  if (parsedUrl.searchParams.get("for") && parsedUrl.searchParams.get("token")) {
    boardToken = parsedUrl.searchParams.get("for");
    jobId = parsedUrl.searchParams.get("token");
  } else {
    const segments = parsedUrl.pathname.split("/").filter(Boolean).map(safeDecode);
    const jobsIdx = segments.indexOf("jobs");
    if (jobsIdx !== -1 && jobsIdx > 0 && segments[jobsIdx + 1]) {
      boardToken = segments[jobsIdx - 1];
      jobId = segments[jobsIdx + 1];
    } else if (segments.length >= 2) {
      boardToken = segments[0];
      jobId = segments[1];
    }
  }

  if (!boardToken || !jobId) {
    throw new Error(`Invalid Greenhouse URL "${parsedUrl.href}": missing board token or job ID`);
  }

  // EU-hosted boards (job-boards.eu.greenhouse.io) are still served by the global boards-api host; boards-api.eu.greenhouse.io does not exist.
  const apiHost = "boards-api.greenhouse.io";
  const apiUrl = `https://${apiHost}/v1/boards/${encodeURIComponent(boardToken)}/jobs/${encodeURIComponent(jobId)}?questions=true`;

  const res = await fetchWithTimeout(apiUrl, fetchImpl);
  if (!res.ok) {
    throw new Error(`Greenhouse API error: HTTP ${res.status} ${res.statusText}`);
  }
  const data = await res.json();

  const decodedHtml = decodeHtmlEntities(data.content || "");
  const descriptionText = htmlToPlainText(decodedHtml);
  const requirementsText = extractRequirements(descriptionText);

  let remote = null;
  const locName = data.location?.name || "";
  if (/remote/i.test(locName) || /remote/i.test(data.title || "")) {
    remote = true;
  } else if (Array.isArray(data.metadata)) {
    const workplaceMeta = data.metadata.find((m) => /workplace|remote/i.test(m.name || ""));
    if (workplaceMeta && workplaceMeta.value) {
      remote = /remote/i.test(String(workplaceMeta.value));
    }
  }

  let compensation = null;
  if (Array.isArray(data.metadata)) {
    const compMeta = data.metadata.find((m) => /salary|compensation|pay/i.test(m.name || ""));
    if (compMeta && compMeta.value) {
      compensation = String(compMeta.value);
    }
  }

  const companyName = data.company_name || (boardToken.charAt(0).toUpperCase() + boardToken.slice(1));

  return {
    source: "greenhouse",
    url: parsedUrl.href,
    title: data.title || "",
    company: companyName,
    location: locName,
    remote,
    compensation,
    descriptionText,
    requirementsText,
    questions: Array.isArray(data.questions) ? data.questions : [],
    fetchedAt: new Date().toISOString()
  };
}

async function fetchLeverPosting(parsedUrl, fetchImpl) {
  const segments = parsedUrl.pathname.split("/").filter(Boolean).map(safeDecode);
  const company = segments[0];
  const jobId = segments[1];
  if (!company || !jobId) {
    throw new Error(`Invalid Lever URL "${parsedUrl.href}": expected jobs.lever.co/{company}/{jobId}`);
  }

  const isEu = parsedUrl.hostname.includes("eu.lever.co");
  const apiHost = isEu ? "api.eu.lever.co" : "api.lever.co";
  const apiUrl = `https://${apiHost}/v0/postings/${encodeURIComponent(company)}/${encodeURIComponent(jobId)}`;

  const res = await fetchWithTimeout(apiUrl, fetchImpl);
  if (!res.ok) {
    throw new Error(`Lever API error: HTTP ${res.status} ${res.statusText}`);
  }
  const data = await res.json();

  const descParts = [];
  if (data.descriptionPlain) {
    descParts.push(data.descriptionPlain.trim());
  } else if (data.description) {
    descParts.push(htmlToPlainText(data.description));
  }

  let requirementsFromList = null;
  if (Array.isArray(data.lists)) {
    for (const list of data.lists) {
      const heading = list.text || "";
      const listContent = htmlToPlainText(list.content || "");
      const formatted = heading ? `${heading}\n${listContent}` : listContent;
      descParts.push(formatted);

      if (
        !requirementsFromList &&
        /requirements|qualifications|what you(?:'ll| will)? (?:bring|need)|what we(?:'re| are)? looking for/i.test(heading)
      ) {
        requirementsFromList = formatted;
      }
    }
  }

  if (data.additionalPlain) {
    descParts.push(data.additionalPlain.trim());
  } else if (data.additional) {
    descParts.push(htmlToPlainText(data.additional));
  }

  const descriptionText = descParts.join("\n\n").trim();
  const requirementsText = requirementsFromList || extractRequirements(descriptionText);

  let remote = null;
  if (data.workplaceType === "remote") {
    remote = true;
  } else if (data.workplaceType === "onsite") {
    remote = false;
  } else if (data.categories?.location) {
    remote = /remote/i.test(data.categories.location);
  }

  let compensation = null;
  if (typeof data.salaryRange === "string") {
    compensation = data.salaryRange;
  } else if (data.salaryRange && (data.salaryRange.min != null || data.salaryRange.max != null)) {
    const curr = data.salaryRange.currency || "";
    const range = [data.salaryRange.min, data.salaryRange.max].filter((v) => v != null).join(" - ");
    const interval = data.salaryRange.interval ? ` (${data.salaryRange.interval})` : "";
    compensation = `${curr ? curr + " " : ""}${range}${interval}`.trim();
  }

  const companyName = company.charAt(0).toUpperCase() + company.slice(1);

  return {
    source: "lever",
    url: data.hostedUrl || parsedUrl.href,
    title: data.text || "",
    company: companyName,
    location: data.categories?.location || data.country || "",
    remote,
    compensation,
    descriptionText,
    requirementsText,
    questions: [],
    fetchedAt: new Date().toISOString()
  };
}

async function fetchWorkablePosting(parsedUrl, fetchImpl) {
  const segments = parsedUrl.pathname.split("/").filter(Boolean).map(safeDecode);
  let account = null;
  let shortcode = null;

  if (segments[1] === "j") {
    account = segments[0];
    shortcode = segments[2];
  } else if (segments[0] === "j") {
    shortcode = segments[1];
  } else if (segments.length >= 2) {
    account = segments[0];
    shortcode = segments[1];
  } else {
    shortcode = segments[0];
  }

  if (!shortcode) {
    throw new Error(`Invalid Workable URL "${parsedUrl.href}": missing shortcode`);
  }

  let apiUrl;
  if (account) {
    apiUrl = `https://apply.workable.com/api/v2/accounts/${encodeURIComponent(account)}/jobs/${encodeURIComponent(shortcode)}`;
  } else {
    apiUrl = `https://apply.workable.com/api/v1/widget/jobs/${encodeURIComponent(shortcode)}`;
  }

  const res = await fetchWithTimeout(apiUrl, fetchImpl);
  if (!res.ok) {
    throw new Error(`Workable API error: HTTP ${res.status} ${res.statusText}`);
  }
  const data = await res.json();

  const descParts = [];
  if (data.description) descParts.push(htmlToPlainText(data.description));
  if (data.requirements) descParts.push("Requirements\n" + htmlToPlainText(data.requirements));
  if (data.benefits) descParts.push("Benefits\n" + htmlToPlainText(data.benefits));

  const descriptionText = descParts.join("\n\n").trim();
  const requirementsText = data.requirements
    ? htmlToPlainText(data.requirements)
    : extractRequirements(descriptionText);

  let remote = null;
  if (typeof data.remote === "boolean") {
    remote = data.remote;
  } else if (data.workplace) {
    remote = /remote/i.test(data.workplace);
  }

  let compensation = null;
  if (typeof data.salary === "string") {
    compensation = data.salary;
  } else if (data.salary && typeof data.salary === "object") {
    const range = [data.salary.min, data.salary.max].filter((v) => v != null).join(" - ");
    compensation = `${range}${data.salary.currency ? " " + data.salary.currency : ""}`.trim() || null;
  }

  const loc = [data.location?.city, data.location?.region, data.location?.country].filter(Boolean).join(", ");
  const companyName = account ? account.charAt(0).toUpperCase() + account.slice(1) : "";

  return {
    source: "workable",
    url: parsedUrl.href,
    title: data.title || "",
    company: companyName,
    location: loc,
    remote,
    compensation,
    descriptionText,
    requirementsText,
    questions: Array.isArray(data.questions) ? data.questions : [],
    fetchedAt: new Date().toISOString()
  };
}

async function fetchGenericPosting(parsedUrl, fetchImpl, { preloadedHtml } = {}) {
  let html = preloadedHtml;

  if (!html) {
    const res = await fetchWithTimeout(parsedUrl.href, fetchImpl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    });

    if (!res.ok) {
      throw new Error(`Generic fetch error: HTTP ${res.status} ${res.statusText}`);
    }

    html = await res.text();
  }

  // 1. Try JSON-LD JobPosting
  const jsonLdRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  let jobPosting = null;

  while ((match = jsonLdRegex.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (Array.isArray(parsed)) {
        jobPosting = parsed.find((item) => item["@type"] === "JobPosting" || item.type === "JobPosting");
      } else if (Array.isArray(parsed["@graph"])) {
        jobPosting = parsed["@graph"].find((item) => item["@type"] === "JobPosting" || item.type === "JobPosting");
      } else if (parsed["@type"] === "JobPosting" || parsed.type === "JobPosting") {
        jobPosting = parsed;
      }
      if (jobPosting) break;
    } catch {}
  }

  if (jobPosting) {
    const title = jobPosting.title || jobPosting.name || "";
    let company = "";
    if (typeof jobPosting.hiringOrganization === "string") {
      company = jobPosting.hiringOrganization;
    } else if (jobPosting.hiringOrganization?.name) {
      company = jobPosting.hiringOrganization.name;
    }

    let location = "";
    if (jobPosting.jobLocation) {
      const loc = jobPosting.jobLocation;
      if (typeof loc === "string") {
        location = loc;
      } else if (loc.address) {
        const addr = loc.address;
        location = [addr.addressLocality, addr.addressRegion, addr.addressCountry].filter(Boolean).join(", ");
      } else if (loc.name) {
        location = loc.name;
      }
    }

    const remote =
      jobPosting.jobLocationType === "TELECOMMUTE" ||
      /remote|telecommute/i.test(JSON.stringify(jobPosting.jobLocation || {}))
        ? true
        : null;

    let compensation = null;
    const baseSal = jobPosting.baseSalary || jobPosting.estimatedSalary;
    if (baseSal) {
      const val = baseSal.value;
      if (typeof val === "object" && val !== null) {
        compensation = `${val.minValue || ""} - ${val.maxValue || ""} ${baseSal.currency || ""}`.trim();
      } else if (val != null) {
        compensation = `${val} ${baseSal.currency || ""}`.trim();
      }
    }

    const descriptionText = htmlToPlainText(jobPosting.description || "");
    const requirementsText =
      (jobPosting.experienceRequirements ? htmlToPlainText(jobPosting.experienceRequirements) : null) ||
      (jobPosting.qualifications ? htmlToPlainText(jobPosting.qualifications) : null) ||
      extractRequirements(descriptionText);

    return {
      source: "generic",
      url: parsedUrl.href,
      title,
      company,
      location,
      remote,
      compensation,
      descriptionText,
      requirementsText,
      questions: [],
      fetchedAt: new Date().toISOString()
    };
  }

  // 2. Fallback to HTML heuristic extraction
  const ogTitleMatch = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i);
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title = ogTitleMatch
    ? decodeHtmlEntities(ogTitleMatch[1])
    : titleMatch
    ? decodeHtmlEntities(titleMatch[1].trim())
    : h1Match
    ? htmlToPlainText(h1Match[1])
    : "";

  const ogSiteMatch = html.match(/<meta[^>]*property=["']og:site_name["'][^>]*content=["']([^"']+)["']/i);
  const company = ogSiteMatch ? decodeHtmlEntities(ogSiteMatch[1]) : parsedUrl.hostname;

  let bodyContent = html;
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  if (articleMatch) {
    bodyContent = articleMatch[1];
  } else if (mainMatch) {
    bodyContent = mainMatch[1];
  }

  const descriptionText = htmlToPlainText(bodyContent);
  const requirementsText = extractRequirements(descriptionText);
  const remote = /remote/i.test(descriptionText.slice(0, 1000)) ? true : null;

  return {
    source: "generic",
    url: parsedUrl.href,
    title,
    company,
    location: "",
    remote,
    compensation: null,
    descriptionText,
    requirementsText,
    questions: [],
    fetchedAt: new Date().toISOString()
  };
}

async function getJobPosting(url, { fetchImpl = fetch, summary = false } = {}) {
  const parsed = validateUrl(url);

  if (isPrivateHost(parsed.hostname)) {
    throw new Error(`Refused: private IP or disallowed host "${parsed.hostname}"`);
  }

  let finalUrl = parsed.href;
  let resolvedFrom = undefined;
  let resolved = undefined;
  let preloadedHtml = undefined;

  const isAgg = isAggregatorHost(parsed);
  const isDou = isDouHost(parsed);
  const initialAdapter = detectAdapter(parsed);

  if (isAgg || isDou || initialAdapter === "generic") {
    const resolution = await resolveApplyUrl(url, { fetchImpl });
    resolvedFrom = resolution.resolvedFrom;
    resolved = resolution.resolved;
    finalUrl = resolution.url;
    preloadedHtml = resolution.html;
  }

  const finalParsed = validateUrl(finalUrl);
  if (isPrivateHost(finalParsed.hostname)) {
    throw new Error(`Refused: private IP or disallowed host "${finalParsed.hostname}"`);
  }

  const adapter = detectAdapter(finalParsed);

  let posting;
  switch (adapter) {
    case "ashby":
      posting = await fetchAshbyPosting(finalParsed, fetchImpl);
      break;
    case "greenhouse":
      posting = await fetchGreenhousePosting(finalParsed, fetchImpl);
      break;
    case "lever":
      posting = await fetchLeverPosting(finalParsed, fetchImpl);
      break;
    case "workable":
      posting = await fetchWorkablePosting(finalParsed, fetchImpl);
      break;
    default:
      posting = await fetchGenericPosting(finalParsed, fetchImpl, { preloadedHtml });
      break;
  }

  if (resolvedFrom !== undefined && (isAgg || isDou || resolved)) {
    posting.resolvedFrom = resolvedFrom;
    posting.resolved = resolved;
    posting.url = finalUrl;
  }

  if (summary) {
    return {
      source: posting.source,
      url: posting.url,
      ...(posting.resolvedFrom !== undefined ? { resolvedFrom: posting.resolvedFrom, resolved: posting.resolved } : {}),
      title: posting.title,
      company: posting.company,
      location: posting.location,
      remote: posting.remote,
      compensation: posting.compensation,
      geoHints: extractGeoHints(posting.descriptionText),
      requirementsText: posting.requirementsText ? posting.requirementsText.slice(0, 2500) : null,
      questions: posting.questions
    };
  }

  return posting;
}

module.exports = {
  getJobPosting,
  resolveApplyUrl,
  extractGeoHints,
  findOutboundAtsLink,
  isPrivateHost,
  isAggregatorHost,
  isDouHost,
  isKnownAtsHost,
  decodeHtmlEntities,
  htmlToPlainText,
  extractRequirements,
  detectAdapter,
  validateUrl
};

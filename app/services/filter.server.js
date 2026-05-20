import prisma from "../db.server.js";

const DEFAULT_BRANDS = [
  { brand: "Disney", riskLevel: "high" },
  { brand: "Marvel", riskLevel: "high" },
  { brand: "DC Comics", riskLevel: "high" },
  { brand: "Pixar", riskLevel: "high" },
  { brand: "Nike", riskLevel: "high" },
  { brand: "Adidas", riskLevel: "high" },
  { brand: "Under Armour", riskLevel: "high" },
  { brand: "Apple", riskLevel: "high" },
  { brand: "Microsoft", riskLevel: "high" },
  { brand: "Sony", riskLevel: "high" },
  { brand: "Samsung", riskLevel: "medium" },
  { brand: "Louis Vuitton", riskLevel: "high" },
  { brand: "Gucci", riskLevel: "high" },
  { brand: "Chanel", riskLevel: "high" },
  { brand: "Prada", riskLevel: "high" },
  { brand: "Pokemon", riskLevel: "high" },
  { brand: "Hello Kitty", riskLevel: "high" },
  { brand: "Sanrio", riskLevel: "high" },
  { brand: "Warner Bros", riskLevel: "high" },
  { brand: "Universal", riskLevel: "medium" },
  { brand: "HBO", riskLevel: "high" },
  { brand: "LEGO", riskLevel: "medium" },
  { brand: "Hasbro", riskLevel: "medium" },
  { brand: "Mattel", riskLevel: "medium" },
];

const DEFAULT_CATEGORIES = [
  "Books",
  "Music",
  "Movies & TV",
  "Software",
  "Digital Content",
  "Video Games",
  "Magazine Subscriptions",
  "Kindle",
  "Audible",
  "MP3 Downloads",
];

const DEFAULT_KEYWORDS = [
  "Official Licensed",
  "Trademark",
  "Copyright ©",
  "All Rights Reserved",
  "Licensed Product",
  "Officially Licensed",
];

export async function initDefaultFilters() {
  const [existingBrands, existingCats, existingKws] = await Promise.all([
    prisma.brandBlacklist.count(),
    prisma.categoryBlacklist.count(),
    prisma.keywordFilter.count(),
  ]);

  if (existingBrands === 0) {
    await prisma.brandBlacklist.createMany({ data: DEFAULT_BRANDS });
  }

  if (existingCats === 0) {
    await prisma.categoryBlacklist.createMany({
      data: DEFAULT_CATEGORIES.map((c) => ({ category: c })),
    });
  }

  if (existingKws === 0) {
    await prisma.keywordFilter.createMany({
      data: DEFAULT_KEYWORDS.map((k) => ({ keyword: k })),
    });
  }
}

export async function checkProductFilter(productData) {
  const [brands, categories, keywords] = await Promise.all([
    prisma.brandBlacklist.findMany({ where: { enabled: true } }),
    prisma.categoryBlacklist.findMany({ where: { enabled: true } }),
    prisma.keywordFilter.findMany({ where: { enabled: true } }),
  ]);

  const title = (productData.title || "").toLowerCase();
  const brand = (productData.brand || "").toLowerCase();
  const category = (productData.category || "").toLowerCase();
  const desc = (productData.description || "").toLowerCase();
  const bullets = (productData.featureBullets || "").toLowerCase();
  const fullText = `${title} ${desc} ${bullets}`;

  const reasons = [];
  let riskLevel = "safe";
  let blocked = false;

  // 1. Brand blacklist check
  for (const b of brands) {
    const bLow = b.brand.toLowerCase();
    if (brand.includes(bLow) || title.includes(bLow)) {
      reasons.push(`Brand: ${b.brand}`);
      if (b.riskLevel === "high") {
        riskLevel = "high";
        blocked = true;
      } else if (b.riskLevel === "medium" && riskLevel !== "high") {
        riskLevel = "medium";
      } else if (b.riskLevel === "low" && riskLevel === "safe") {
        riskLevel = "low";
      }
    }
  }

  // 2. Category blacklist check (always blocks)
  for (const c of categories) {
    if (category.includes(c.category.toLowerCase())) {
      reasons.push(`Category: ${c.category}`);
      riskLevel = "high";
      blocked = true;
      break;
    }
  }

  // 3. Keyword filter check (warns but doesn't block unless already blocked)
  for (const k of keywords) {
    if (fullText.includes(k.keyword.toLowerCase())) {
      reasons.push(`Keyword: "${k.keyword}"`);
      if (riskLevel === "safe") riskLevel = "medium";
    }
  }

  return {
    blocked,
    riskLevel,          // safe / low / medium / high
    reasons,
    filterReason: reasons.join(", ") || null,
  };
}

export { RISK_EMOJI, RISK_LABEL } from "../utils/filter-constants.js";

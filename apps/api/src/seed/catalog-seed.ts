import type { Prisma } from "../generated/prisma/client.js";

const productId = (number: number) =>
  `01920000-0000-7000-8000-${String(1000 + number).padStart(12, "0")}`;
const variantId = (number: number) =>
  `01920000-0000-7000-8000-${String(2000 + number).padStart(12, "0")}`;
const PRODUCTS = [
  {
    name: "Lanterns of Velora",
    publisher: "Copper Finch Games",
    description:
      "Build a glowing network of lanterns across Velora. Connect districts, plan your routes, and bring the riverside city to life.",
  },
  {
    name: "Lanterns of Velora: Mistbound Docks",
    publisher: "Copper Finch Games",
    description:
      "Explore the mistbound docks of Velora with new waterfront districts and shifting ferry routes.",
    base: 1,
  },
  {
    name: "Clockwork Orchard",
    publisher: "Amber Meeple Studio",
    description:
      "Tend an orchard of intricate clockwork trees. Combine clever mechanisms and harvest your creations at just the right moment.",
  },
  {
    name: "The Saltwind Atlas",
    publisher: "Paper Badger Works",
    description:
      "Chart a windswept archipelago, discover quiet harbors, and piece together your own atlas of the open sea.",
  },
  {
    name: "The Saltwind Atlas: Glass Isles",
    publisher: "Paper Badger Works",
    description:
      "Sail beyond the familiar horizon to the Glass Isles, where new routes reward careful exploration.",
    base: 4,
  },
  {
    name: "Mossbridge Market",
    publisher: "Copper Finch Games",
    description:
      "Trade curious goods at the woodland market. Fill your stalls, negotiate with neighbors, and prepare for the harvest fair.",
  },
  {
    name: "Tinker's Comet",
    publisher: "Amber Meeple Studio",
    description:
      "A compact print-and-play game about inventive stargazers building a machine to follow a passing comet.",
  },
  {
    name: "Echoes of Brindlewood",
    publisher: "Paper Badger Works",
    description:
      "Follow the stories hidden beneath an ancient woodland. An archived title preserved in the distributor's catalog.",
    inactive: true,
  },
] satisfies {
  name: string;
  publisher: string;
  description: string;
  base?: number;
  inactive?: boolean;
}[];
const VARIANTS = [
  {
    product: 1,
    sku: "LOV-EN-STD",
    language: "en",
    edition: "Standard",
    unitPriceMinor: 4200,
  },
  {
    product: 1,
    sku: "LOV-SR-STD",
    language: "sr",
    edition: "Standard",
    unitPriceMinor: 4200,
  },
  {
    product: 2,
    sku: "LOV-MD-EN",
    language: "en",
    edition: "Standard",
    unitPriceMinor: 1800,
  },
  {
    product: 3,
    sku: "CWO-EN-STD",
    language: "en",
    edition: "Standard",
    unitPriceMinor: 3500,
  },
  {
    product: 3,
    sku: "CWO-EN-DLX",
    language: "en",
    edition: "Deluxe",
    unitPriceMinor: 5500,
  },
  {
    product: 4,
    sku: "SWA-EN-STD",
    language: "en",
    edition: "Standard",
    unitPriceMinor: 4800,
  },
  {
    product: 5,
    sku: "SWA-GI-EN",
    language: "en",
    edition: "Standard",
    unitPriceMinor: 2200,
  },
  {
    product: 6,
    sku: "MBM-SR-STD",
    language: "sr",
    edition: "Standard",
    unitPriceMinor: 2900,
  },
  {
    product: 6,
    sku: "MBM-EN-STD",
    language: "en",
    edition: "Standard",
    unitPriceMinor: 2900,
    inactive: true,
  },
  {
    product: 7,
    sku: "TKC-EN-STD",
    language: "en",
    edition: "Standard",
    unitPriceMinor: 0,
  },
  {
    product: 8,
    sku: "EBW-EN-STD",
    language: "en",
    edition: "Standard",
    unitPriceMinor: 3900,
  },
];

export async function seedCatalog(tx: Prisma.TransactionClient): Promise<void> {
  for (const [index, fixture] of PRODUCTS.entries()) {
    const { base, inactive, ...fields } = fixture;
    const data = {
      ...fields,
      type: base ? ("EXPANSION" as const) : ("BASE_GAME" as const),
      baseProductId: base ? productId(base) : null,
      isActive: !inactive,
    };
    const id = productId(index + 1);
    await tx.product.upsert({
      where: { id },
      create: { id, ...data },
      update: data,
    });
  }
  for (const [index, fixture] of VARIANTS.entries()) {
    const { product, inactive, ...fields } = fixture;
    const data = {
      ...fields,
      productId: productId(product),
      isActive: !inactive,
    };
    const id = variantId(index + 1);
    await tx.productVariant.upsert({
      where: { id },
      create: { id, ...data },
      update: data,
    });
  }
}

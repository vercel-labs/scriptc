// JSON round trips of typed records: build, stringify, parse back into a
// declared shape, aggregate, and stringify the summary.
interface LineItem {
  sku: string;
  quantity: number;
  price: number;
}
interface Order {
  id: number;
  customer: string;
  region: string;
  priority: boolean;
  items: LineItem[];
  tags: string[];
}
interface Summary {
  region: string;
  orders: number;
  revenue: number;
  topSku: string;
}
interface RegionTotals {
  orders: number;
  revenue: number;
  skus: Map<string, number>;
}

let seed = 12345;
function random(): number {
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  return seed / 4294967296;
}

const regions = ["north", "south", "east", "west", "central"];
function makeOrders(count: number): Order[] {
  const orders: Order[] = [];
  for (let i = 0; i < count; i++) {
    const items: LineItem[] = [];
    const n = 1 + Math.floor(random() * 6);
    for (let j = 0; j < n; j++) {
      items.push({
        sku: "sku-" + Math.floor(random() * 500),
        quantity: 1 + Math.floor(random() * 9),
        price: Math.round(random() * 10000) / 100,
      });
    }
    orders.push({
      id: i,
      customer: "customer-" + Math.floor(random() * 2000),
      region: regions[i % regions.length]!,
      priority: random() < 0.2,
      items,
      tags: random() < 0.5 ? ["web"] : ["store", "promo"],
    });
  }
  return orders;
}

function summarize(orders: Order[]): Summary[] {
  const byRegion = new Map<string, RegionTotals>();
  for (const order of orders) {
    let entry = byRegion.get(order.region);
    if (entry === undefined) {
      entry = { orders: 0, revenue: 0, skus: new Map<string, number>() };
      byRegion.set(order.region, entry);
    }
    entry.orders++;
    for (const item of order.items) {
      entry.revenue += item.quantity * item.price;
      entry.skus.set(item.sku, (entry.skus.get(item.sku) ?? 0) + item.quantity);
    }
  }
  const result: Summary[] = [];
  for (const [region, entry] of byRegion) {
    let topSku = "";
    let topCount = -1;
    for (const [sku, count] of entry.skus) {
      if (count > topCount || (count === topCount && sku < topSku)) {
        topSku = sku;
        topCount = count;
      }
    }
    result.push({ region, orders: entry.orders, revenue: Math.round(entry.revenue * 100) / 100, topSku });
  }
  result.sort((a, b) => (a.region < b.region ? -1 : a.region > b.region ? 1 : 0));
  return result;
}

const scale = Number(process.argv[2] ?? "1");
const orders = makeOrders(Math.floor(4000 * scale));
let checksum = 0;
let last = "";
for (let round = 0; round < 6; round++) {
  const text = JSON.stringify(orders);
  checksum += text.length;
  const parsed = JSON.parse(text) as Order[];
  const summary = summarize(parsed);
  last = JSON.stringify(summary);
  checksum += last.length;
}
console.log(last);
console.log("checksum", checksum);

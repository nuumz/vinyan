let nextId = 1;

export function formatCurrency(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

export function generateId(): number {
  return nextId++;
}

export function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T;
}

export function groupBy<T>(items: T[], key: keyof T): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  for (const item of items) {
    const groupKey = String(item[key]);
    if (!result[groupKey]) {
      result[groupKey] = [];
    }
    result[groupKey]!.push(item);
  }
  return result;
}

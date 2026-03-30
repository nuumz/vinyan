import type { Order, OrderItem } from "./types.ts";
import type { UserService } from "./user-service.ts";
import { generateId } from "./utils.ts";
import { NotFoundError, ValidationError } from "./errors.ts";
import { MAX_ORDER_ITEMS } from "./constants.ts";

export class OrderService {
  private orders = new Map<number, Order>();

  constructor(private userService: UserService) {}

  createOrder(userId: number, items: OrderItem[]): Order {
    const user = this.userService.getUser(userId);
    if (!user) {
      throw new NotFoundError("User", userId);
    }
    if (items.length === 0) {
      throw new ValidationError(["Order must have at least one item"]);
    }
    if (items.length > MAX_ORDER_ITEMS) {
      throw new ValidationError(["Cannot exceed " + MAX_ORDER_ITEMS + " items"]);
    }
    const order: Order = {
      id: generateId(),
      userId,
      items,
      total: this.calculateTotal(items),
      status: "pending",
    };
    this.orders.set(order.id, order);
    return order;
  }

  getOrder(id: number): Order | undefined {
    return this.orders.get(id);
  }

  calculateTotal(items: OrderItem[]): number {
    return items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  }

  getUserOrders(userId: number): Order[] {
    return Array.from(this.orders.values()).filter(
      (order) => order.userId === userId
    );
  }
}

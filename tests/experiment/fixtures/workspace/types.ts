export type UserRole = "admin" | "user";
export type OrderStatus = "pending" | "shipped" | "delivered";

export interface User {
  id: number;
  name: string;
  email: string;
  role: UserRole;
}

export interface OrderItem {
  productId: number;
  name: string;
  quantity: number;
  price: number;
}

export interface Order {
  id: number;
  userId: number;
  items: OrderItem[];
  total: number;
  status: OrderStatus;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

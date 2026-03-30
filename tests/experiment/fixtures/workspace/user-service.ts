import type { User } from "./types.ts";
import { generateId } from "./utils.ts";
import { isValidEmail } from "./validators.ts";
import { NotFoundError, ValidationError } from "./errors.ts";

export class UserService {
  private users = new Map<number, User>();

  getUser(id: number): User | undefined {
    return this.users.get(id);
  }

  getUserOrThrow(id: number): User {
    const user = this.users.get(id);
    if (!user) {
      throw new NotFoundError("User", id);
    }
    return user;
  }

  createUser(name: string, email: string): User {
    if (!isValidEmail(email)) {
      throw new ValidationError(["Invalid email format"]);
    }
    const user: User = { id: generateId(), name, email, role: "user" };
    this.users.set(user.id, user);
    return user;
  }

  validateEmail(email: string): boolean {
    return isValidEmail(email);
  }

  listUsers(): User[] {
    return Array.from(this.users.values());
  }
}

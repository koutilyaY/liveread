import { PrismaClient } from "@prisma/client";

let client: PrismaClient | null = null;

export function prisma(): PrismaClient {
  if (!client) {
    client = new PrismaClient({
      log:
        process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
    });
  }
  return client;
}

export async function disconnectPrisma(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = null;
  }
}

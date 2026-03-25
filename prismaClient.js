import { prisma } from "./prismaClient.js";
import { supabaseAdmin } from "./supabaseClient.js";
import { PrismaClient } from "@prisma/client";

export const prisma = new PrismaClient();
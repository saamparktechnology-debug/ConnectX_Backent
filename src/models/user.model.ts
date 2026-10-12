import { PoolConnection } from "mysql2/promise";
import { pool } from "../config/database.js";
import { CryptoUtil } from "../utils/crypto.util.js";

export interface UserRow {
  id: number;
  uuid: string;
  public_id: string | null;
  phone: string;
  gender: "male" | "female";
  nickname: string;
  real_name: string | null;
  birth_year: number | null;
  id_number: Buffer | null;
  id_number_key_id: string | null;
  id_name: string | null;
  avatar_url: string | null;
  primary_language: string | null;
  verification_status: "unverified" | "pending" | "approved" | "rejected";
  account_state: "active" | "suspended" | "banned" | "deactivated";
  suspension_reason: string | null;
  is_online: boolean;
  wallet_balance: string;
  onboarding_completed_at: string | null;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  terms_accepted_at: string | null;
  channels_acknowledged_at: string | null;
}

export class UserModel {
  /**
   * Generates the next public_id atomically using the sequence table.
   * MUST be called inside a transaction.
   */
  public static async nextPublicId(conn: PoolConnection): Promise<string> {
    const [rows]: any = await conn.execute(
      `SELECT next_number FROM user_id_sequence WHERE id = 1 FOR UPDATE`,
    );
    if (!rows.length) {
      throw new Error("user_id_sequence row missing");
    }
    const next = Number(rows[0].next_number);
    await conn.execute(
      `UPDATE user_id_sequence SET next_number = ? WHERE id = 1`,
      [next + 1],
    );
    return `CX${String(next).padStart(6, "0")}`;
  }

  public static async findById(id: number): Promise<UserRow | null> {
    const [rows]: any = await pool.execute(
      `SELECT * FROM users WHERE id = ? AND deleted_at IS NULL`,
      [id],
    );
    return rows[0] || null;
  }

  public static async findByPhone(phone: string): Promise<UserRow | null> {
    const [rows]: any = await pool.execute(
      `SELECT * FROM users WHERE phone = ? AND deleted_at IS NULL`,
      [phone],
    );
    return rows[0] || null;
  }

  public static async findByPublicId(
    publicId: string,
  ): Promise<UserRow | null> {
    const [rows]: any = await pool.execute(
      `SELECT * FROM users WHERE public_id = ? AND deleted_at IS NULL`,
      [publicId],
    );
    return rows[0] || null;
  }

  public static async findByUuid(uuid: string): Promise<UserRow | null> {
    const [rows]: any = await pool.execute(
      `SELECT * FROM users WHERE uuid = ? AND deleted_at IS NULL`,
      [uuid],
    );
    return rows[0] || null;
  }

  public static async lockById(
    conn: PoolConnection,
    id: number,
  ): Promise<UserRow | null> {
    const [rows]: any = await conn.execute(
      `SELECT * FROM users WHERE id = ? AND deleted_at IS NULL FOR UPDATE`,
      [id],
    );
    return rows[0] || null;
  }

  public static async lockByUuid(
    conn: PoolConnection,
    uuid: string,
  ): Promise<UserRow | null> {
    const [rows]: any = await conn.execute(
      `SELECT * FROM users WHERE uuid = ? AND deleted_at IS NULL FOR UPDATE`,
      [uuid],
    );
    return rows[0] || null;
  }

  /**
   * Creates a user. Assigns public_id automatically.
   * Must be called inside a transaction (for the sequence lock).
   */
  public static async create(
    conn: PoolConnection,
    data: {
      uuid: string;
      phone: string;
      gender: "male" | "female";
      nickname: string;
      birthYear?: number | null;
      avatarUrl?: string | null;
    },
  ): Promise<number> {
    const publicId = await this.nextPublicId(conn);

    const [result]: any = await conn.execute(
      `INSERT INTO users (uuid, public_id, phone, gender, nickname, birth_year, avatar_url)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        data.uuid,
        publicId,
        data.phone,
        data.gender,
        data.nickname,
        data.birthYear ?? null,
        data.avatarUrl ?? null,
      ],
    );
    return result.insertId;
  }

  public static async updateOnlineStatus(
    conn: PoolConnection | typeof pool,
    userId: number,
    isOnline: boolean,
  ): Promise<void> {
    await conn.execute(
      `UPDATE users 
       SET is_online = ?, last_seen_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3) 
       WHERE id = ?`,
      [isOnline, userId],
    );
  }

  public static async updateBalance(
    conn: PoolConnection,
    userId: number,
    newBalance: string,
  ): Promise<void> {
    await conn.execute(
      `UPDATE users SET wallet_balance = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?`,
      [newBalance, userId],
    );
  }

  public static async suspendAccount(
    conn: PoolConnection,
    userId: number,
    adminId: number,
    reason: string,
  ): Promise<void> {
    await conn.execute(
      `UPDATE users 
       SET account_state = 'suspended', suspension_reason = ?, suspended_by = ?, suspended_at = CURRENT_TIMESTAMP(3), updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ?`,
      [reason, adminId, userId],
    );
  }

  public static async getDiscoverableFemales(
    limit: number = 20,
    offset: number = 0,
  ): Promise<UserRow[]> {
    const [rows]: any = await pool.execute(
      `SELECT id, uuid, public_id, nickname, avatar_url, primary_language, is_online, last_seen_at
       FROM users 
       WHERE gender = 'female' 
         AND is_online = TRUE 
         AND verification_status = 'approved' 
         AND account_state = 'active'
         AND deleted_at IS NULL
       ORDER BY last_seen_at DESC 
       LIMIT ? OFFSET ?`,
      [limit, offset],
    );
    return rows;
  }

  public static async saveKYCAndOnboarding(
    conn: PoolConnection,
    userId: number,
    data: {
      realName: string;
      idNumberEncrypted: Buffer;
      idName: string;
      birthYear: number;
      primaryLanguage: string;
      avatarUrl?: string | null;
    },
  ): Promise<void> {
    await conn.execute(
      `UPDATE users 
       SET real_name = ?, id_number = ?, id_name = ?, birth_year = ?, 
           primary_language = ?, avatar_url = COALESCE(?, avatar_url),
           onboarding_completed_at = CURRENT_TIMESTAMP(3),
           updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ?`,
      [
        data.realName,
        data.idNumberEncrypted,
        data.idName,
        data.birthYear,
        data.primaryLanguage,
        data.avatarUrl ?? null,
        userId,
      ],
    );
  }

  public static async getDecryptedIdNumber(
    userId: number,
  ): Promise<string | null> {
    const [rows]: any = await pool.execute(
      `SELECT id_number FROM users WHERE id = ? AND deleted_at IS NULL`,
      [userId],
    );
    if (!rows.length || !rows[0].id_number) return null;
    return CryptoUtil.decryptAES256GCM(rows[0].id_number);
  }
}

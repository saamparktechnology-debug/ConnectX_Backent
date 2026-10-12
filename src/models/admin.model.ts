// src/models/admin.model.ts
import { pool } from "../config/database.js";

export interface AdminRow {
  id: number;
  uuid: string;
  email: string;
  password_hash: string;
  role: string;
  is_active: boolean;
  last_login_at: string | null;
}

export class AdminModel {
  public static async findByEmail(email: string): Promise<AdminRow | null> {
    const [rows]: any = await pool.execute(
      `SELECT * FROM admins WHERE email = ?`,
      [email],
    );
    return rows[0] || null;
  }

  public static async updateLastLogin(id: number): Promise<void> {
    await pool.execute(
      `UPDATE admins SET last_login_at = CURRENT_TIMESTAMP(3) WHERE id = ?`,
      [id],
    );
  }

  public static async insertAuditLog(data: {
    adminId: number;
    action: string;
    entityType: string;
    entityId: string;
    beforeState?: any;
    afterState?: any;
    ipAddress?: string | null;
    userAgent?: string | null;
  }): Promise<void> {
    await pool.execute(
      `INSERT INTO admin_audit_logs 
       (admin_id, action, entity_type, entity_id, before_state, after_state, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        data.adminId,
        data.action,
        data.entityType,
        data.entityId,
        data.beforeState ? JSON.stringify(data.beforeState) : null,
        data.afterState ? JSON.stringify(data.afterState) : null,
        data.ipAddress ?? null,
        data.userAgent ?? null,
      ],
    );
  }
}

// src/modules/recharges/payu.service.ts
import { env } from "../../config/env.js";
import { CryptoUtil } from "../../utils/crypto.util.js";

export class PayUService {
  /**
   * Generates the forward SHA-512 hash:
   * sha512(key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5||||||salt)
   */
  public static generatePaymentHash(params: {
    txnid: string;
    amount: string; // Formatted to 2 decimal places e.g. "104.00"
    productinfo: string;
    firstname: string;
    email: string;
    udf1?: string;
    udf2?: string;
    udf3?: string;
    udf4?: string;
    udf5?: string;
  }): string {
    const hashString = `${env.PAYU_MERCHANT_KEY}|${params.txnid}|${params.amount}|${params.productinfo}|${params.firstname}|${params.email}|${params.udf1 || ""}|${params.udf2 || ""}|${params.udf3 || ""}|${params.udf4 || ""}|${params.udf5 || ""}||||||${env.PAYU_MERCHANT_SALT}`;
    return CryptoUtil.sha512(hashString);
  }

  /**
   * Validates PayU reverse callback signature:
   * sha512(additionalCharges|salt|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key)
   */
  public static verifyCallbackHash(payload: Record<string, string>): boolean {
    const {
      key,
      txnid,
      amount,
      productinfo,
      firstname,
      email,
      status,
      additionalCharges,
      hash,
      udf1 = "",
      udf2 = "",
      udf3 = "",
      udf4 = "",
      udf5 = "",
    } = payload;

    let basePattern = `${env.PAYU_MERCHANT_SALT}|${status}||||||${udf5}|${udf4}|${udf3}|${udf2}|${udf1}|${email}|${firstname}|${productinfo}|${amount}|${txnid}|${key}`;
    if (additionalCharges) {
      basePattern = `${additionalCharges}|${basePattern}`;
    }

    const calculatedHash = CryptoUtil.sha512(basePattern);
    return calculatedHash.toLowerCase() === (hash || "").toLowerCase();
  }
}

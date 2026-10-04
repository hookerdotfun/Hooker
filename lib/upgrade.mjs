// Loader-v3 instructions for upgrading the hook with an upgrade authority that signs elsewhere (the
// cold wallet). Used by scripts/upgrade-hook-mainnet.mjs and rehearsed by test/upgrade-local.mjs.
import { PublicKey, TransactionInstruction, SystemProgram, SYSVAR_RENT_PUBKEY, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";

export const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
export const programDataOf = (program) => PublicKey.findProgramAddressSync([new PublicKey(program).toBuffer()], LOADER)[0];
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };

/** ExtendProgramChecked (9): programdata, program, authority (signer), system, payer (signer). */
export const extendIx = ({ program, authority, bytes }) => new TransactionInstruction({ programId: LOADER, data: Buffer.concat([u32(9), u32(bytes)]), keys: [
  { pubkey: programDataOf(program), isSigner: false, isWritable: true }, { pubkey: new PublicKey(program), isSigner: false, isWritable: true },
  { pubkey: authority, isSigner: true, isWritable: false }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  { pubkey: authority, isSigner: true, isWritable: true } ] });

/**
 * ExtendProgram (6): programdata, program, system, payer (signer). No authority: anyone may pay to grow a
 * program account. Mainnet still takes this form (4 Oct 2026: ExtendProgramChecked is refused there as
 * invalid instruction data); Agave 4.0 test validators take only the checked one.
 */
export const extendUncheckedIx = ({ program, payer, bytes }) => new TransactionInstruction({ programId: LOADER, data: Buffer.concat([u32(6), u32(bytes)]), keys: [
  { pubkey: programDataOf(program), isSigner: false, isWritable: true }, { pubkey: new PublicKey(program), isSigner: false, isWritable: true },
  { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: payer, isSigner: true, isWritable: true } ] });

/** Upgrade (3): programdata, program, buffer, spill, rent, clock, authority (signer). The buffer's rent goes to `spill`. */
export const upgradeIx = ({ program, buffer, authority, spill = authority }) => new TransactionInstruction({ programId: LOADER, data: u32(3), keys: [
  { pubkey: programDataOf(program), isSigner: false, isWritable: true }, { pubkey: new PublicKey(program), isSigner: false, isWritable: true },
  { pubkey: new PublicKey(buffer), isSigner: false, isWritable: true }, { pubkey: spill, isSigner: false, isWritable: true },
  { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }, { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
  { pubkey: authority, isSigner: true, isWritable: false } ] });

/** Bytes to add so the program account holds `soLen` bytes plus `margin` (programdata has a 45-byte header). */
export const extendNeeded = (programDataLen, soLen, margin = 0) => Math.max(0, 45 + soLen + margin - programDataLen);

/** Whether the deployed program equals `so` (trailing zero padding allowed). */
export function sameProgram(programDataBytes, so) {
  const d = programDataBytes.subarray(45);
  return d.length >= so.length && d.subarray(0, so.length).equals(so) && d.subarray(so.length).every((x) => x === 0);
}

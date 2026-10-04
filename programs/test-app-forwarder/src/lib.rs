//! Stand-in for "an app's own program" (e.g. the Pump app, 6Vo3245e…): forwards ONE instruction
//! by CPI. accounts[0] = target program, accounts[1..] = the target's accounts (flags passed
//! through); data = the target's instruction data. Test fixture only.
use solana_program::{
    account_info::AccountInfo, entrypoint, entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction}, program::invoke, pubkey::Pubkey,
};

entrypoint!(process);

fn process(_program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let (target, rest) = accounts.split_first().ok_or(solana_program::program_error::ProgramError::NotEnoughAccountKeys)?;
    let metas = rest
        .iter()
        .map(|a| AccountMeta { pubkey: *a.key, is_signer: a.is_signer, is_writable: a.is_writable })
        .collect();
    invoke(&Instruction { program_id: *target.key, accounts: metas, data: data.to_vec() }, rest)
}

// Usage: RPC_URL=... DEPLOYER_KEY=... ESCROW_SIGNER=0x.. TREASURY=0x.. BOND_TOKEN=0x.. TOKENS=0xUSDC,0xUSDT \
//        npx hardhat run scripts/deploy.js --network target
const { ethers } = require('hardhat');

async function main() {
  const { ESCROW_SIGNER, TREASURY, BOND_TOKEN, TOKENS, MIN_BOND = '500' } = process.env;
  if (!ESCROW_SIGNER || !TREASURY || !BOND_TOKEN || !TOKENS) throw new Error('ESCROW_SIGNER, TREASURY, BOND_TOKEN and TOKENS are required');
  const Escrow = await ethers.getContractFactory('MarketEscrow');
  const escrow = await Escrow.deploy(ESCROW_SIGNER, TREASURY, BOND_TOKEN, ethers.parseUnits(MIN_BOND, 6), TOKENS.split(','));
  await escrow.waitForDeployment();
  console.log('MarketEscrow deployed at', await escrow.getAddress());
  console.log('Set ESCROW_CONTRACT_ADDRESS to this value in the API environment.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// Usage: RPC_URL=... DEPLOYER_KEY=... ESCROW_SIGNER=0x.. TREASURY=0x.. BOND_TOKEN=0x.. TOKENS=0xUSDC,0xUSDT \
//        VRF_COORDINATOR=0x.. VRF_KEY_HASH=0x.. VRF_SUB_ID=123 \
//        npx hardhat run scripts/deploy.js --network target
//
// Dispute panels are drawn with Chainlink VRF v2.5. Take the coordinator address and key hash
// (gas lane) for your network from Chainlink's VRF docs, create and fund a subscription, then
// add the deployed contract as a consumer of it. The coordinator can't be changed after
// deployment. ALLOW_BLOCKHASH_RANDOMNESS=1 deploys without VRF (test networks only: block
// proposers could bias the draw).
const { ethers } = require('hardhat');

async function main() {
  const { ESCROW_SIGNER, TREASURY, BOND_TOKEN, TOKENS, MIN_BOND = '500', VRF_COORDINATOR, VRF_KEY_HASH, VRF_SUB_ID, ALLOW_BLOCKHASH_RANDOMNESS } = process.env;
  if (!ESCROW_SIGNER || !TREASURY || !BOND_TOKEN || !TOKENS) throw new Error('ESCROW_SIGNER, TREASURY, BOND_TOKEN and TOKENS are required');
  if (!VRF_COORDINATOR && ALLOW_BLOCKHASH_RANDOMNESS !== '1') throw new Error('VRF_COORDINATOR is required (or ALLOW_BLOCKHASH_RANDOMNESS=1 on a test network)');
  if (VRF_COORDINATOR && (!VRF_KEY_HASH || !VRF_SUB_ID)) throw new Error('VRF_KEY_HASH and VRF_SUB_ID are required with VRF_COORDINATOR');

  const Escrow = await ethers.getContractFactory('MarketEscrow');
  const escrow = await Escrow.deploy(ESCROW_SIGNER, TREASURY, BOND_TOKEN, ethers.parseUnits(MIN_BOND, 6), TOKENS.split(','), VRF_COORDINATOR ?? ethers.ZeroAddress);
  await escrow.waitForDeployment();
  const address = await escrow.getAddress();
  console.log('MarketEscrow deployed at', address);
  if (VRF_COORDINATOR) {
    await (await escrow.setVrfConfig(VRF_KEY_HASH, VRF_SUB_ID, 3, 100_000)).wait();
    console.log(`VRF configured. Add ${address} as a consumer of subscription ${VRF_SUB_ID} in the Chainlink VRF app before the first dispute.`);
  } else {
    console.log('Deployed WITHOUT VRF (block-hash randomness): test networks only.');
  }
  console.log('Set ESCROW_CONTRACT_ADDRESS to this address in the API environment.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

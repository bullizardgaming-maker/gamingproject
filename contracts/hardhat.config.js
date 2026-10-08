require('@nomicfoundation/hardhat-ethers');
require('@nomicfoundation/hardhat-chai-matchers');
const { subtask } = require('hardhat/config');
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require('hardhat/builtin-tasks/task-names');

const SOLC_VERSION = '0.8.24';

// Use the solc-js build shipped in the `solc` npm package instead of downloading
// a native compiler (works in restricted-network CI).
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, _hre, runSuper) => {
  if (args.solcVersion === SOLC_VERSION) {
    const solc = require('solc');
    return { compilerPath: require.resolve('solc/soljson.js'), isSolcJs: true, version: SOLC_VERSION, longVersion: solc.version() };
  }
  return runSuper();
});

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: SOLC_VERSION,
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: 'cancun' },
  },
  networks: {
    hardhat: {},
    ...(process.env.RPC_URL && process.env.DEPLOYER_KEY
      ? { target: { url: process.env.RPC_URL, accounts: [process.env.DEPLOYER_KEY] } }
      : {}),
  },
};

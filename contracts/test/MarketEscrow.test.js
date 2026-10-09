const { expect } = require('chai');
const { ethers } = require('hardhat');
const { time, mine } = require('@nomicfoundation/hardhat-network-helpers');

const DAY = 24 * 3600;
const USDC = (n) => ethers.parseUnits(String(n), 6);

// Must match apps/api/src/domain/web3.ts (ESCROW_TYPES).
const TYPES = {
  Terms: [
    { name: 'orderId', type: 'bytes32' },
    { name: 'buyer', type: 'address' },
    { name: 'seller', type: 'address' },
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'feeBps', type: 'uint16' },
    { name: 'milestoneBps', type: 'uint16[]' },
    { name: 'milestoneDelays', type: 'uint64[]' },
    { name: 'deliveryDeadline', type: 'uint64' },
    { name: 'expiry', type: 'uint64' },
  ],
};
const Vote = { None: 0, Buyer: 1, Seller: 2 };

async function deploy() {
  const [owner, platformSigner, treasury, buyer, seller, ...rest] = await ethers.getSigners();
  const Token = await ethers.getContractFactory('MockStablecoin');
  const usdc = await Token.deploy('USD Coin', 'USDC');
  const Escrow = await ethers.getContractFactory('MarketEscrow');
  const escrow = await Escrow.deploy(platformSigner.address, treasury.address, await usdc.getAddress(), USDC(500), [await usdc.getAddress()], ethers.ZeroAddress);
  await usdc.mint(buyer.address, USDC(10_000));
  await usdc.connect(buyer).approve(await escrow.getAddress(), ethers.MaxUint256);
  return { owner, platformSigner, treasury, buyer, seller, validators: rest, usdc, escrow };
}

async function signedTerms(env, overrides = {}) {
  const { escrow, usdc, buyer, seller, platformSigner } = env;
  const now = await time.latest();
  const terms = {
    orderId: ethers.id(`order-${Math.random()}`),
    buyer: buyer.address,
    seller: seller.address,
    token: await usdc.getAddress(),
    amount: USDC(100),
    feeBps: 1299,
    milestoneBps: [3000, 7000],
    milestoneDelays: [0, 14 * DAY],
    deliveryDeadline: now + 3 * DAY,
    expiry: now + 3600,
    ...overrides,
  };
  const domain = { name: 'MarketEscrow', version: '1', chainId: (await ethers.provider.getNetwork()).chainId, verifyingContract: await escrow.getAddress() };
  const signature = await platformSigner.signTypedData(domain, TYPES, terms);
  return { terms, signature };
}

describe('MarketEscrow', () => {
  describe('deposit', () => {
    it('accepts platform-signed terms and locks the stablecoin', async () => {
      const env = await deploy();
      const { terms, signature } = await signedTerms(env);
      await expect(env.escrow.connect(env.buyer).createEscrow(terms, signature))
        .to.emit(env.escrow, 'EscrowCreated')
        .withArgs(terms.orderId, env.buyer.address, env.seller.address, terms.token, terms.amount);
      expect(await env.usdc.balanceOf(await env.escrow.getAddress())).to.equal(USDC(100));
    });

    it('rejects terms the buyer tampered with (e.g. zero fee)', async () => {
      const env = await deploy();
      const { terms, signature } = await signedTerms(env);
      await expect(env.escrow.connect(env.buyer).createEscrow({ ...terms, feeBps: 0 }, signature)).to.be.revertedWithCustomError(env.escrow, 'BadSignature');
      await expect(env.escrow.connect(env.buyer).createEscrow({ ...terms, seller: env.buyer.address }, signature)).to.be.revertedWithCustomError(env.escrow, 'InvalidTerms');
    });

    it('rejects expired terms, wrong caller, duplicates and bad schedules', async () => {
      const env = await deploy();
      const { terms, signature } = await signedTerms(env);
      await expect(env.escrow.connect(env.seller).createEscrow(terms, signature)).to.be.revertedWithCustomError(env.escrow, 'NotParty');
      await env.escrow.connect(env.buyer).createEscrow(terms, signature);
      await expect(env.escrow.connect(env.buyer).createEscrow(terms, signature)).to.be.revertedWithCustomError(env.escrow, 'AlreadyExists');

      const late = await signedTerms(env);
      await time.increase(3601);
      await expect(env.escrow.connect(env.buyer).createEscrow(late.terms, late.signature)).to.be.revertedWithCustomError(env.escrow, 'Expired');

      const bad = await signedTerms(env, { milestoneBps: [5000, 4000] });
      await expect(env.escrow.connect(env.buyer).createEscrow(bad.terms, bad.signature)).to.be.revertedWithCustomError(env.escrow, 'InvalidTerms');
    });
  });

  describe('milestone release', () => {
    it('releases 30% on credential delivery and 70% after the 14-day insurance window', async () => {
      const env = await deploy();
      const { terms, signature } = await signedTerms(env);
      await env.escrow.connect(env.buyer).createEscrow(terms, signature);

      await expect(env.escrow.connect(env.seller).claim(terms.orderId, 0)).to.be.revertedWithCustomError(env.escrow, 'NotDelivered');
      await env.escrow.connect(env.seller).markDelivered(terms.orderId, 1);

      await env.escrow.connect(env.seller).claim(terms.orderId, 0);
      // 30.00 gross, 12.99% fee -> 3.897 fee, 26.103 to seller
      expect(await env.usdc.balanceOf(env.seller.address)).to.equal(USDC('26.103'));
      expect(await env.usdc.balanceOf(env.treasury.address)).to.equal(USDC('3.897'));

      await expect(env.escrow.connect(env.seller).claim(terms.orderId, 1)).to.be.revertedWithCustomError(env.escrow, 'TooEarly');
      await time.increase(14 * DAY);
      await expect(env.escrow.connect(env.seller).claim(terms.orderId, 1)).to.emit(env.escrow, 'EscrowSettled').withArgs(terms.orderId, 0);
      expect(await env.usdc.balanceOf(env.seller.address)).to.equal(USDC('87.01'));
      expect(await env.usdc.balanceOf(env.treasury.address)).to.equal(USDC('12.99'));
      expect(await env.usdc.balanceOf(await env.escrow.getAddress())).to.equal(0);
    });

    it('lets the buyer approve early but never twice', async () => {
      const env = await deploy();
      const { terms, signature } = await signedTerms(env, { milestoneBps: [10000], milestoneDelays: [3 * DAY], feeBps: 999 });
      await env.escrow.connect(env.buyer).createEscrow(terms, signature);
      await env.escrow.connect(env.seller).markDelivered(terms.orderId, 0);
      await env.escrow.connect(env.buyer).approve(terms.orderId, 0);
      expect(await env.usdc.balanceOf(env.seller.address)).to.equal(USDC('90.01'));
      await expect(env.escrow.connect(env.buyer).approve(terms.orderId, 0)).to.be.revertedWithCustomError(env.escrow, 'WrongStatus');
    });

    it('refunds the buyer when nothing was delivered by the deadline', async () => {
      const env = await deploy();
      const { terms, signature } = await signedTerms(env);
      await env.escrow.connect(env.buyer).createEscrow(terms, signature);
      await expect(env.escrow.connect(env.buyer).reclaimUndelivered(terms.orderId)).to.be.revertedWithCustomError(env.escrow, 'TooEarly');
      await time.increase(3 * DAY + 1);
      await expect(env.escrow.connect(env.buyer).reclaimUndelivered(terms.orderId)).to.emit(env.escrow, 'EscrowSettled').withArgs(terms.orderId, 1);
      expect(await env.usdc.balanceOf(env.buyer.address)).to.equal(USDC(10_000));
    });
  });

  describe('decentralized arbitration', () => {
    async function disputedEscrow(env, validatorCount = 7) {
      for (const v of env.validators.slice(0, validatorCount)) {
        await env.usdc.mint(v.address, USDC(1_000));
        await env.usdc.connect(v).approve(await env.escrow.getAddress(), ethers.MaxUint256);
        await env.escrow.connect(v).bond(USDC(1_000));
      }
      const { terms, signature } = await signedTerms(env);
      await env.escrow.connect(env.buyer).createEscrow(terms, signature);
      await env.escrow.connect(env.seller).markDelivered(terms.orderId, 1);
      await env.escrow.connect(env.seller).claim(terms.orderId, 0); // 30% already paid
      await expect(env.escrow.connect(env.buyer).openDispute(terms.orderId, ethers.id('chat-log-hash'))).to.emit(env.escrow, 'DisputeOpened');
      // Seller can no longer claim while disputed.
      await time.increase(14 * DAY);
      await expect(env.escrow.connect(env.seller).claim(terms.orderId, 1)).to.be.revertedWithCustomError(env.escrow, 'WrongStatus');
      await mine(2);
      await env.escrow.drawPanel(terms.orderId);
      const [panel] = await env.escrow.getPanel(terms.orderId);
      const byAddr = Object.fromEntries(env.validators.map((v) => [v.address, v]));
      return { terms, panel: panel.map((a) => byAddr[a]) };
    }

    async function vote(env, orderId, validator, choice) {
      const salt = ethers.hexlify(ethers.randomBytes(32));
      await env.escrow.connect(validator).commitVote(orderId, await env.escrow.commitmentFor(orderId, choice, salt, validator.address));
      return () => env.escrow.connect(validator).revealVote(orderId, choice, salt);
    }

    it('draws a bonded panel, runs commit-reveal and executes the majority verdict', async () => {
      const env = await deploy();
      const { terms, panel } = await disputedEscrow(env);
      expect(panel).to.have.length(5);
      expect(new Set(panel.map((p) => p.address)).size).to.equal(5);
      for (const p of panel) expect(await env.escrow.activeAssignments(p.address)).to.equal(1);
      await expect(env.escrow.connect(panel[0]).unbond(1)).to.be.revertedWithCustomError(env.escrow, 'BondLocked');

      const reveals = [];
      reveals.push(await vote(env, terms.orderId, panel[0], Vote.Buyer));
      reveals.push(await vote(env, terms.orderId, panel[1], Vote.Buyer));
      reveals.push(await vote(env, terms.orderId, panel[2], Vote.Buyer));
      reveals.push(await vote(env, terms.orderId, panel[3], Vote.Seller));
      await vote(env, terms.orderId, panel[4], Vote.Seller); // commits but never reveals

      await expect(reveals[0]()).to.be.revertedWithCustomError(env.escrow, 'WrongPhase'); // still commit phase
      await time.increase(2 * DAY + 1);
      for (const r of reveals) await r();
      await expect(env.escrow.finalizeDispute(terms.orderId)).to.be.revertedWithCustomError(env.escrow, 'TooEarly');
      await time.increase(DAY);

      const buyerBefore = await env.usdc.balanceOf(env.buyer.address);
      await expect(env.escrow.finalizeDispute(terms.orderId)).to.emit(env.escrow, 'DisputeResolved').withArgs(terms.orderId, Vote.Buyer, 3, 1);

      // Remaining 70.00; 2% arbitration fee (1.40) split among the 3 majority voters.
      const reward = USDC('1.40') / 3n;
      expect(await env.usdc.balanceOf(env.buyer.address)).to.equal(buyerBefore + USDC(70) - reward * 3n);
      for (const p of panel.slice(0, 3)) expect(await env.usdc.balanceOf(p.address)).to.equal(reward);
      expect(await env.escrow.bonds(panel[4].address)).to.equal(USDC(900)); // slashed 10%
      expect(await env.escrow.bonds(panel[3].address)).to.equal(USDC(1_000)); // minority is not slashed
      for (const p of panel) expect(await env.escrow.activeAssignments(p.address)).to.equal(0);
      await env.escrow.connect(panel[0]).unbond(USDC(1_000));
      expect(await env.usdc.balanceOf(await env.escrow.getAddress())).to.equal(USDC(1_000 * 6 + 900 - 1_000));
    });

    it('splits the remaining funds on a tie', async () => {
      const env = await deploy();
      const { terms, panel } = await disputedEscrow(env);
      const r1 = await vote(env, terms.orderId, panel[0], Vote.Buyer);
      const r2 = await vote(env, terms.orderId, panel[1], Vote.Seller);
      await time.increase(2 * DAY + 1);
      await r1();
      await r2();
      await time.increase(DAY);
      const sellerBefore = await env.usdc.balanceOf(env.seller.address);
      await expect(env.escrow.finalizeDispute(terms.orderId)).to.emit(env.escrow, 'EscrowSettled').withArgs(terms.orderId, 2);
      // 35.00 gross to the seller minus 12.99% fee.
      expect((await env.usdc.balanceOf(env.seller.address)) - sellerBefore).to.equal(USDC('30.4535'));
    });

    it('rejects non-panelists and forged reveals', async () => {
      const env = await deploy();
      const { terms, panel } = await disputedEscrow(env);
      await expect(env.escrow.connect(env.buyer).commitVote(terms.orderId, ethers.ZeroHash)).to.be.revertedWithCustomError(env.escrow, 'NotPanelist');
      await vote(env, terms.orderId, panel[0], Vote.Seller);
      await time.increase(2 * DAY + 1);
      await expect(env.escrow.connect(panel[0]).revealVote(terms.orderId, Vote.Buyer, ethers.ZeroHash)).to.be.revertedWithCustomError(env.escrow, 'BadReveal');
    });

    it('refuses to draw when too few independent validators are bonded', async () => {
      const env = await deploy();
      for (const v of env.validators.slice(0, 3)) {
        await env.usdc.mint(v.address, USDC(1_000));
        await env.usdc.connect(v).approve(await env.escrow.getAddress(), ethers.MaxUint256);
        await env.escrow.connect(v).bond(USDC(1_000));
      }
      const { terms, signature } = await signedTerms(env);
      await env.escrow.connect(env.buyer).createEscrow(terms, signature);
      await env.escrow.connect(env.buyer).openDispute(terms.orderId, ethers.ZeroHash);
      await mine(2);
      await expect(env.escrow.drawPanel(terms.orderId)).to.be.revertedWithCustomError(env.escrow, 'NotEnoughValidators');
    });
  });

  describe('panel draw with Chainlink VRF', () => {
    const KEY_HASH = ethers.id('gas-lane');
    async function deployVrf(validatorCount = 10) {
      const [owner, platformSigner, treasury, buyer, seller, outsider, ...validators] = await ethers.getSigners();
      const usdc = await (await ethers.getContractFactory('MockStablecoin')).deploy('USD Coin', 'USDC');
      const vrf = await (await ethers.getContractFactory('MockVRFCoordinator')).deploy();
      const Escrow = await ethers.getContractFactory('MarketEscrow');
      const escrow = await Escrow.deploy(platformSigner.address, treasury.address, await usdc.getAddress(), USDC(500), [await usdc.getAddress()], await vrf.getAddress());
      await usdc.mint(buyer.address, USDC(10_000));
      await usdc.connect(buyer).approve(await escrow.getAddress(), ethers.MaxUint256);
      for (const v of validators.slice(0, validatorCount)) {
        await usdc.mint(v.address, USDC(1_000));
        await usdc.connect(v).approve(await escrow.getAddress(), ethers.MaxUint256);
        await escrow.connect(v).bond(USDC(1_000));
      }
      return { owner, platformSigner, treasury, buyer, seller, outsider, validators, usdc, vrf, escrow };
    }
    async function dispute(env) {
      const { terms, signature } = await signedTerms(env);
      await env.escrow.connect(env.buyer).createEscrow(terms, signature);
      await env.escrow.connect(env.seller).markDelivered(terms.orderId, 1);
      const tx = env.escrow.connect(env.buyer).openDispute(terms.orderId, ethers.id('chat-log-hash'));
      return { orderId: terms.orderId, tx };
    }

    it('fixes the coordinator at deployment and needs a subscription before disputes', async () => {
      const env = await deployVrf();
      expect(await env.escrow.vrfCoordinator()).to.equal(await env.vrf.getAddress());
      const { tx } = await dispute(env);
      await expect(tx).to.be.revertedWithCustomError(env.escrow, 'VrfNotConfigured');
      await expect(env.escrow.connect(env.outsider).setVrfConfig(KEY_HASH, 1, 3, 100_000)).to.be.revertedWithCustomError(env.escrow, 'OwnableUnauthorizedAccount');
    });

    it('draws the panel from the VRF answer, and only the coordinator can answer', async () => {
      const env = await deployVrf();
      await env.escrow.setVrfConfig(KEY_HASH, 42, 3, 100_000);
      const { orderId, tx } = await dispute(env);
      await expect(tx).to.emit(env.escrow, 'RandomnessRequested').withArgs(orderId, 1n);
      const [consumer, keyHash, subId, numWords, extraArgs] = await env.vrf.requestOf(1);
      expect([consumer, keyHash, subId, numWords]).to.deep.equal([await env.escrow.getAddress(), KEY_HASH, 42n, 1n]);
      // Chainlink's ExtraArgsV1 tag followed by nativePayment = false.
      expect(extraArgs).to.equal(ethers.dataSlice(ethers.id('VRF ExtraArgsV1'), 0, 4) + '0'.repeat(64));

      await expect(env.escrow.drawPanel(orderId)).to.be.revertedWithCustomError(env.escrow, 'TooEarly');
      await expect(env.escrow.connect(env.outsider).rawFulfillRandomWords(1, [123])).to.be.revertedWithCustomError(env.escrow, 'OnlyCoordinator');
      await expect(env.vrf.fulfill(1, 123)).to.emit(env.escrow, 'RandomnessFulfilled').withArgs(orderId, 1n);
      await expect(env.escrow.drawPanel(orderId)).to.emit(env.escrow, 'PanelDrawn');
      const [panel] = await env.escrow.getPanel(orderId);
      expect(panel).to.have.length(5);
      expect(panel).to.not.include(env.buyer.address);
      expect(panel).to.not.include(env.seller.address);
      // A second answer to the same request changes nothing.
      await env.vrf.fulfill(1, 999);
      expect(await env.escrow.getPanel(orderId).then((r) => r[0])).to.deep.equal(panel);
    });

    it('different random words draw different panels', async () => {
      const env = await deployVrf();
      await env.escrow.setVrfConfig(KEY_HASH, 42, 3, 100_000);
      const panels = [];
      for (const word of [1n, 2n ** 200n + 7n]) {
        const { orderId, tx } = await dispute(env);
        await tx;
        await env.vrf.fulfill(await env.vrf.lastRequestId(), word);
        await env.escrow.drawPanel(orderId);
        panels.push([...(await env.escrow.getPanel(orderId))[0]].sort().join());
      }
      expect(panels[0]).to.not.equal(panels[1]);
    });

    it('lets anyone re-request after an hour without an answer, ignoring the stale request', async () => {
      const env = await deployVrf();
      await env.escrow.setVrfConfig(KEY_HASH, 42, 3, 100_000);
      const { orderId, tx } = await dispute(env);
      await tx;
      await expect(env.escrow.connect(env.outsider).retryRandomness(orderId)).to.be.revertedWithCustomError(env.escrow, 'TooEarly');
      await time.increase(3601);
      await expect(env.escrow.connect(env.outsider).retryRandomness(orderId)).to.emit(env.escrow, 'RandomnessRequested').withArgs(orderId, 2n);
      await expect(env.vrf.fulfill(1, 5)).to.not.emit(env.escrow, 'RandomnessFulfilled'); // superseded
      await expect(env.escrow.drawPanel(orderId)).to.be.revertedWithCustomError(env.escrow, 'TooEarly');
      await expect(env.vrf.fulfill(2, 6)).to.emit(env.escrow, 'RandomnessFulfilled').withArgs(orderId, 2n);
      await env.escrow.drawPanel(orderId);
      await expect(env.escrow.retryRandomness(orderId)).to.be.revertedWithCustomError(env.escrow, 'WrongPhase');
    });
  });
});

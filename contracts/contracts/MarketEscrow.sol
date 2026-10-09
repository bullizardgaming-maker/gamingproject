// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @dev The part of Chainlink's VRF v2.5 coordinator this contract uses.
interface IVRFCoordinatorV2Plus {
    struct RandomWordsRequest {
        bytes32 keyHash;
        uint256 subId;
        uint16 requestConfirmations;
        uint32 callbackGasLimit;
        uint32 numWords;
        bytes extraArgs;
    }

    function requestRandomWords(RandomWordsRequest calldata req) external returns (uint256 requestId);
}

/**
 * @title MarketEscrow
 * @notice Non-custodial stablecoin escrow for the marketplace's Web3 rail.
 *
 *  - Buyers lock USDC/USDT against platform-signed EIP-712 terms (seller, amount,
 *    fee and release schedule cannot be altered by the buyer).
 *  - Funds release per milestone: the seller marks a milestone delivered and may
 *    claim it once its inspection delay passes; the buyer may approve early.
 *    e.g. accounts: 30% on credential delivery, 70% after a 14-day window.
 *  - Either party can dispute unreleased funds. A panel of bonded validators is
 *    drawn at random, votes with commit-reveal, and the majority outcome is
 *    executed by the contract. Majority voters share an arbitration fee;
 *    validators who fail to reveal are slashed. No platform key can move
 *    disputed funds.
 *
 * Randomness: with a VRF coordinator (Chainlink VRF v2.5, fixed at deployment so no key
 * can later swap in a source it controls), opening a dispute requests a random word; the
 * callback only stores the seed, and anyone then calls drawPanel. Neither the parties, the
 * platform nor block proposers can steer who is drawn. If a request is never fulfilled
 * (e.g. an unfunded subscription) anyone may re-request after VRF_RETRY_AFTER. Without a
 * coordinator (local development and tests) the seed is the hash of a future block, which
 * block proposers could bias.
 */
contract MarketEscrow is EIP712, ReentrancyGuard, Ownable2Step {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------
    // Types
    // ------------------------------------------------------------------
    struct Terms {
        bytes32 orderId;
        address buyer;
        address seller;
        address token;
        uint256 amount;
        uint16 feeBps;
        uint16[] milestoneBps;
        uint64[] milestoneDelays;
        uint64 deliveryDeadline;
        uint64 expiry;
    }

    enum Status {
        None,
        Active,
        Disputed,
        Settled
    }

    enum Vote {
        None,
        Buyer,
        Seller
    }

    struct Escrow {
        address buyer;
        address seller;
        address token;
        uint256 amount;
        uint256 released; // gross amount already paid out (seller + fees)
        uint16 feeBps;
        Status status;
        uint64 deliveryDeadline;
        uint16[] milestoneBps;
        uint64[] milestoneDelays;
        uint64[] deliveredAt;
        uint256 releasedMask;
    }

    struct Dispute {
        address openedBy;
        bytes32 evidenceHash;
        uint64 drawBlock;
        uint64 commitDeadline;
        uint64 revealDeadline;
        address[] panel;
        uint8 buyerVotes;
        uint8 sellerVotes;
        uint256 vrfRequestId;
        uint64 vrfRequestedAt;
        bytes32 seed;
        mapping(address => bytes32) commits;
        mapping(address => Vote) votes;
    }

    bytes32 public constant TERMS_TYPEHASH = keccak256(
        "Terms(bytes32 orderId,address buyer,address seller,address token,uint256 amount,uint16 feeBps,uint16[] milestoneBps,uint64[] milestoneDelays,uint64 deliveryDeadline,uint64 expiry)"
    );

    uint8 public constant PANEL_SIZE = 5;
    uint16 public constant MAX_FEE_BPS = 2_000;
    uint16 public constant ARBITRATION_FEE_BPS = 200; // 2% of disputed funds to majority voters
    uint16 public constant SLASH_BPS = 1_000; // 10% of bond for failing to reveal
    uint64 public constant COMMIT_PERIOD = 2 days;
    uint64 public constant REVEAL_PERIOD = 1 days;
    uint64 public constant VRF_RETRY_AFTER = 1 hours;
    /// @dev Chainlink VRF v2.5 extra args: tag "VRF ExtraArgsV1", pay in LINK (nativePayment = false).
    bytes4 internal constant VRF_EXTRA_ARGS_V1_TAG = bytes4(keccak256("VRF ExtraArgsV1"));

    // ------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------
    address public signer;
    address public treasury;
    mapping(address => bool) public allowedToken;

    mapping(bytes32 => Escrow) internal _escrows;
    mapping(bytes32 => Dispute) internal _disputes;

    IERC20 public immutable bondToken;
    uint256 public minBond;
    mapping(address => uint256) public bonds;
    mapping(address => uint256) public activeAssignments;
    address[] internal _pool;
    mapping(address => uint256) internal _poolIndexPlusOne;

    /// @notice The randomness source for panel draws; zero means block-hash mode (development only).
    address public immutable vrfCoordinator;
    bytes32 public vrfKeyHash;
    uint256 public vrfSubId;
    uint16 public vrfConfirmations = 3;
    uint32 public vrfCallbackGas = 100_000;
    mapping(uint256 => bytes32) public vrfRequestOrder;

    // ------------------------------------------------------------------
    // Events (consumed by the off-chain indexer)
    // ------------------------------------------------------------------
    event EscrowCreated(bytes32 indexed orderId, address indexed buyer, address indexed seller, address token, uint256 amount);
    event MilestoneDelivered(bytes32 indexed orderId, uint256 index, uint64 at);
    event MilestoneReleased(bytes32 indexed orderId, uint256 index, uint256 toSeller, uint256 fee);
    event EscrowSettled(bytes32 indexed orderId, uint8 outcome); // 0 released, 1 refunded, 2 split
    event DisputeOpened(bytes32 indexed orderId, address indexed by, bytes32 evidenceHash, uint64 drawBlock);
    event PanelDrawn(bytes32 indexed orderId, address[] panel, uint64 commitDeadline, uint64 revealDeadline);
    event VoteCommitted(bytes32 indexed orderId, address indexed validator);
    event VoteRevealed(bytes32 indexed orderId, address indexed validator, Vote vote);
    event DisputeResolved(bytes32 indexed orderId, Vote outcome, uint8 buyerVotes, uint8 sellerVotes);
    event ValidatorBonded(address indexed validator, uint256 total);
    event ValidatorUnbonded(address indexed validator, uint256 total);
    event ValidatorSlashed(address indexed validator, uint256 amount);
    event RandomnessRequested(bytes32 indexed orderId, uint256 requestId);
    event RandomnessFulfilled(bytes32 indexed orderId, uint256 requestId);

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------
    error InvalidTerms();
    error BadSignature();
    error Expired();
    error AlreadyExists();
    error NotParty();
    error WrongStatus();
    error NotDelivered();
    error AlreadyReleased();
    error TooEarly();
    error NothingToDispute();
    error NotPanelist();
    error WrongPhase();
    error BadReveal();
    error NotEnoughValidators();
    error BondLocked();
    error TokenNotAllowed();
    error OnlyCoordinator();
    error VrfNotConfigured();

    constructor(address signer_, address treasury_, IERC20 bondToken_, uint256 minBond_, address[] memory tokens, address vrfCoordinator_)
        EIP712("MarketEscrow", "1")
        Ownable(msg.sender)
    {
        vrfCoordinator = vrfCoordinator_;
        signer = signer_;
        treasury = treasury_;
        bondToken = bondToken_;
        minBond = minBond_;
        for (uint256 i; i < tokens.length; ++i) allowedToken[tokens[i]] = true;
    }

    // ------------------------------------------------------------------
    // Admin (cannot touch escrowed funds)
    // ------------------------------------------------------------------
    /// @notice Subscription and gas lane. These affect billing and speed, not the randomness: the
    /// coordinator (which proves it) is fixed at deployment.
    function setVrfConfig(bytes32 keyHash, uint256 subId, uint16 confirmations, uint32 callbackGas) external onlyOwner {
        vrfKeyHash = keyHash;
        vrfSubId = subId;
        vrfConfirmations = confirmations;
        vrfCallbackGas = callbackGas;
    }

    function setSigner(address s) external onlyOwner {
        signer = s;
    }

    function setTreasury(address t) external onlyOwner {
        treasury = t;
    }

    function setAllowedToken(address token, bool allowed) external onlyOwner {
        allowedToken[token] = allowed;
    }

    function setMinBond(uint256 b) external onlyOwner {
        minBond = b;
    }

    // ------------------------------------------------------------------
    // Escrow lifecycle
    // ------------------------------------------------------------------
    function hashTerms(Terms calldata t) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    TERMS_TYPEHASH,
                    t.orderId,
                    t.buyer,
                    t.seller,
                    t.token,
                    t.amount,
                    t.feeBps,
                    keccak256(abi.encodePacked(t.milestoneBps)),
                    keccak256(abi.encodePacked(t.milestoneDelays)),
                    t.deliveryDeadline,
                    t.expiry
                )
            )
        );
    }

    function createEscrow(Terms calldata t, bytes calldata signature) external nonReentrant {
        if (msg.sender != t.buyer) revert NotParty();
        if (block.timestamp > t.expiry) revert Expired();
        if (!allowedToken[t.token]) revert TokenNotAllowed();
        if (_escrows[t.orderId].status != Status.None) revert AlreadyExists();
        uint256 n = t.milestoneBps.length;
        if (n == 0 || n > 8 || n != t.milestoneDelays.length || t.feeBps > MAX_FEE_BPS || t.amount == 0) revert InvalidTerms();
        if (t.seller == address(0) || t.seller == t.buyer) revert InvalidTerms();
        uint256 total;
        for (uint256 i; i < n; ++i) total += t.milestoneBps[i];
        if (total != 10_000) revert InvalidTerms();
        if (ECDSA.recover(hashTerms(t), signature) != signer) revert BadSignature();

        Escrow storage e = _escrows[t.orderId];
        e.buyer = t.buyer;
        e.seller = t.seller;
        e.token = t.token;
        e.amount = t.amount;
        e.feeBps = t.feeBps;
        e.status = Status.Active;
        e.deliveryDeadline = t.deliveryDeadline;
        e.milestoneBps = t.milestoneBps;
        e.milestoneDelays = t.milestoneDelays;
        e.deliveredAt = new uint64[](n);

        // Pull funds and verify the exact amount arrived (defends against fee-on-transfer tokens).
        IERC20 token = IERC20(t.token);
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(t.buyer, address(this), t.amount);
        if (token.balanceOf(address(this)) - before != t.amount) revert InvalidTerms();

        emit EscrowCreated(t.orderId, t.buyer, t.seller, t.token, t.amount);
    }

    /// @notice Seller marks milestones [0..upTo] as delivered, starting their inspection delays.
    function markDelivered(bytes32 orderId, uint256 upTo) external {
        Escrow storage e = _escrows[orderId];
        if (msg.sender != e.seller) revert NotParty();
        if (e.status != Status.Active) revert WrongStatus();
        if (upTo >= e.milestoneBps.length) revert InvalidTerms();
        for (uint256 i; i <= upTo; ++i) {
            if (e.deliveredAt[i] == 0) {
                e.deliveredAt[i] = uint64(block.timestamp);
                emit MilestoneDelivered(orderId, i, uint64(block.timestamp));
            }
        }
    }

    /// @notice Buyer approves a delivered milestone early.
    function approve(bytes32 orderId, uint256 index) external nonReentrant {
        Escrow storage e = _escrows[orderId];
        if (msg.sender != e.buyer) revert NotParty();
        if (e.status != Status.Active) revert WrongStatus();
        if (index >= e.milestoneBps.length || e.deliveredAt[index] == 0) revert NotDelivered();
        _releaseMilestone(orderId, e, index);
    }

    /// @notice Seller claims a delivered milestone after its inspection delay elapsed without dispute.
    function claim(bytes32 orderId, uint256 index) external nonReentrant {
        Escrow storage e = _escrows[orderId];
        if (msg.sender != e.seller) revert NotParty();
        if (e.status != Status.Active) revert WrongStatus();
        if (index >= e.milestoneBps.length || e.deliveredAt[index] == 0) revert NotDelivered();
        if (block.timestamp < uint256(e.deliveredAt[index]) + e.milestoneDelays[index]) revert TooEarly();
        _releaseMilestone(orderId, e, index);
    }

    /// @notice Buyer recovers funds if the seller never delivered the first milestone.
    function reclaimUndelivered(bytes32 orderId) external nonReentrant {
        Escrow storage e = _escrows[orderId];
        if (msg.sender != e.buyer) revert NotParty();
        if (e.status != Status.Active) revert WrongStatus();
        if (block.timestamp <= e.deliveryDeadline || e.deliveredAt[0] != 0) revert TooEarly();
        uint256 remaining = e.amount - e.released;
        e.released = e.amount;
        e.status = Status.Settled;
        IERC20(e.token).safeTransfer(e.buyer, remaining);
        emit EscrowSettled(orderId, 1);
    }

    function _releaseMilestone(bytes32 orderId, Escrow storage e, uint256 index) internal {
        if (e.releasedMask & (1 << index) != 0) revert AlreadyReleased();
        e.releasedMask |= (1 << index);
        uint256 n = e.milestoneBps.length;
        bool last = e.releasedMask == (1 << n) - 1;
        uint256 share = last ? e.amount - e.released : (e.amount * e.milestoneBps[index]) / 10_000;
        e.released += share;
        uint256 fee = (share * e.feeBps) / 10_000;
        IERC20 token = IERC20(e.token);
        if (fee > 0) token.safeTransfer(treasury, fee);
        token.safeTransfer(e.seller, share - fee);
        emit MilestoneReleased(orderId, index, share - fee, fee);
        if (last) {
            e.status = Status.Settled;
            emit EscrowSettled(orderId, 0);
        }
    }

    // ------------------------------------------------------------------
    // Validators
    // ------------------------------------------------------------------
    function bond(uint256 amount) external nonReentrant {
        bondToken.safeTransferFrom(msg.sender, address(this), amount);
        bonds[msg.sender] += amount;
        if (bonds[msg.sender] >= minBond && _poolIndexPlusOne[msg.sender] == 0) {
            _pool.push(msg.sender);
            _poolIndexPlusOne[msg.sender] = _pool.length;
        }
        emit ValidatorBonded(msg.sender, bonds[msg.sender]);
    }

    function unbond(uint256 amount) external nonReentrant {
        if (activeAssignments[msg.sender] != 0) revert BondLocked();
        bonds[msg.sender] -= amount;
        if (bonds[msg.sender] < minBond) _removeFromPool(msg.sender);
        bondToken.safeTransfer(msg.sender, amount);
        emit ValidatorUnbonded(msg.sender, bonds[msg.sender]);
    }

    function poolSize() external view returns (uint256) {
        return _pool.length;
    }

    function _removeFromPool(address v) internal {
        uint256 idx = _poolIndexPlusOne[v];
        if (idx == 0) return;
        address lastV = _pool[_pool.length - 1];
        _pool[idx - 1] = lastV;
        _poolIndexPlusOne[lastV] = idx;
        _pool.pop();
        _poolIndexPlusOne[v] = 0;
    }

    // ------------------------------------------------------------------
    // Decentralized dispute resolution
    // ------------------------------------------------------------------
    function openDispute(bytes32 orderId, bytes32 evidenceHash) external {
        Escrow storage e = _escrows[orderId];
        if (msg.sender != e.buyer && msg.sender != e.seller) revert NotParty();
        if (e.status != Status.Active) revert WrongStatus();
        if (e.amount == e.released) revert NothingToDispute();
        e.status = Status.Disputed;
        Dispute storage d = _disputes[orderId];
        d.openedBy = msg.sender;
        d.evidenceHash = evidenceHash;
        if (vrfCoordinator != address(0)) _requestRandomness(orderId, d);
        else d.drawBlock = uint64(block.number + 1);
        emit DisputeOpened(orderId, msg.sender, evidenceHash, d.drawBlock);
    }

    function _requestRandomness(bytes32 orderId, Dispute storage d) internal {
        if (vrfKeyHash == bytes32(0) || vrfSubId == 0) revert VrfNotConfigured();
        uint256 requestId = IVRFCoordinatorV2Plus(vrfCoordinator).requestRandomWords(
            IVRFCoordinatorV2Plus.RandomWordsRequest({
                keyHash: vrfKeyHash,
                subId: vrfSubId,
                requestConfirmations: vrfConfirmations,
                callbackGasLimit: vrfCallbackGas,
                numWords: 1,
                extraArgs: abi.encodeWithSelector(VRF_EXTRA_ARGS_V1_TAG, false)
            })
        );
        if (d.vrfRequestId != 0) delete vrfRequestOrder[d.vrfRequestId]; // a late answer to the old request is ignored
        d.vrfRequestId = requestId;
        d.vrfRequestedAt = uint64(block.timestamp);
        vrfRequestOrder[requestId] = orderId;
        emit RandomnessRequested(orderId, requestId);
    }

    /// @notice Called by the VRF coordinator. Only stores the seed (cheap and can't run out of
    /// callback gas); the panel is drawn by a separate drawPanel call.
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external {
        if (msg.sender != vrfCoordinator) revert OnlyCoordinator();
        bytes32 orderId = vrfRequestOrder[requestId];
        if (orderId == bytes32(0)) return; // superseded or unknown: ignore rather than revert
        delete vrfRequestOrder[requestId];
        Dispute storage d = _disputes[orderId];
        if (d.seed != bytes32(0) || d.panel.length != 0) return;
        d.seed = keccak256(abi.encode(randomWords[0], orderId));
        emit RandomnessFulfilled(orderId, requestId);
    }

    /// @notice Anyone may re-request randomness if the coordinator hasn't answered in time.
    function retryRandomness(bytes32 orderId) external {
        Escrow storage e = _escrows[orderId];
        Dispute storage d = _disputes[orderId];
        if (vrfCoordinator == address(0) || e.status != Status.Disputed || d.panel.length != 0 || d.seed != bytes32(0)) revert WrongPhase();
        if (block.timestamp < d.vrfRequestedAt + VRF_RETRY_AFTER) revert TooEarly();
        _requestRandomness(orderId, d);
    }

    /// @notice Anyone may trigger the panel draw once the committed draw block is mined.
    function drawPanel(bytes32 orderId) external {
        Escrow storage e = _escrows[orderId];
        Dispute storage d = _disputes[orderId];
        if (e.status != Status.Disputed || d.panel.length != 0) revert WrongPhase();
        bytes32 seed;
        if (vrfCoordinator != address(0)) {
            if (d.seed == bytes32(0)) revert TooEarly(); // waiting for the VRF answer
            seed = d.seed;
        } else {
            if (block.number <= d.drawBlock) revert TooEarly();
            bytes32 bh = blockhash(d.drawBlock);
            if (bh == bytes32(0)) {
                // Draw block fell out of the 256-block window: commit to a new one.
                d.drawBlock = uint64(block.number + 1);
                return;
            }
            seed = keccak256(abi.encode(bh, orderId));
        }

        // Partial Fisher-Yates over a memory copy of the pool, skipping the parties.
        address[] memory pool = _pool;
        uint256 len = pool.length;
        address[] memory panel = new address[](PANEL_SIZE);
        uint256 picked;
        for (uint256 i; i < len && picked < PANEL_SIZE; ++i) {
            uint256 j = i + (uint256(keccak256(abi.encode(seed, i))) % (len - i));
            (pool[i], pool[j]) = (pool[j], pool[i]);
            address v = pool[i];
            if (v == e.buyer || v == e.seller) continue;
            panel[picked++] = v;
        }
        if (picked < PANEL_SIZE) revert NotEnoughValidators();

        for (uint256 k; k < PANEL_SIZE; ++k) {
            d.panel.push(panel[k]);
            activeAssignments[panel[k]] += 1;
        }
        d.commitDeadline = uint64(block.timestamp + COMMIT_PERIOD);
        d.revealDeadline = d.commitDeadline + REVEAL_PERIOD;
        emit PanelDrawn(orderId, panel, d.commitDeadline, d.revealDeadline);
    }

    function commitmentFor(bytes32 orderId, Vote vote, bytes32 salt, address validator) public pure returns (bytes32) {
        return keccak256(abi.encode(orderId, vote, salt, validator));
    }

    function commitVote(bytes32 orderId, bytes32 commitment) external {
        Dispute storage d = _disputes[orderId];
        if (!_isPanelist(d, msg.sender)) revert NotPanelist();
        if (block.timestamp > d.commitDeadline) revert WrongPhase();
        d.commits[msg.sender] = commitment;
        emit VoteCommitted(orderId, msg.sender);
    }

    function revealVote(bytes32 orderId, Vote vote, bytes32 salt) external {
        Dispute storage d = _disputes[orderId];
        if (!_isPanelist(d, msg.sender)) revert NotPanelist();
        if (block.timestamp <= d.commitDeadline || block.timestamp > d.revealDeadline) revert WrongPhase();
        if (vote == Vote.None || d.votes[msg.sender] != Vote.None) revert BadReveal();
        if (d.commits[msg.sender] != commitmentFor(orderId, vote, salt, msg.sender)) revert BadReveal();
        d.votes[msg.sender] = vote;
        if (vote == Vote.Buyer) d.buyerVotes++;
        else d.sellerVotes++;
        emit VoteRevealed(orderId, msg.sender, vote);
    }

    /// @notice Execute the panel's decision after the reveal period.
    function finalizeDispute(bytes32 orderId) external nonReentrant {
        Escrow storage e = _escrows[orderId];
        Dispute storage d = _disputes[orderId];
        if (e.status != Status.Disputed || d.panel.length == 0) revert WrongPhase();
        if (block.timestamp <= d.revealDeadline) revert TooEarly();

        Vote outcome = d.buyerVotes > d.sellerVotes ? Vote.Buyer : d.sellerVotes > d.buyerVotes ? Vote.Seller : Vote.None;
        IERC20 token = IERC20(e.token);
        uint256 remaining = e.amount - e.released;
        e.released = e.amount;
        e.status = Status.Settled;

        // Pay the arbitration fee to the majority; slash non-revealers.
        uint256 arbFee = outcome == Vote.None ? 0 : (remaining * ARBITRATION_FEE_BPS) / 10_000;
        uint8 winners = outcome == Vote.Buyer ? d.buyerVotes : d.sellerVotes;
        uint256 paidToPanel;
        for (uint256 k; k < d.panel.length; ++k) {
            address v = d.panel[k];
            activeAssignments[v] -= 1;
            Vote cast = d.votes[v];
            if (cast == Vote.None) {
                uint256 slash = (bonds[v] * SLASH_BPS) / 10_000;
                bonds[v] -= slash;
                if (bonds[v] < minBond) _removeFromPool(v);
                bondToken.safeTransfer(treasury, slash);
                emit ValidatorSlashed(v, slash);
            } else if (outcome != Vote.None && cast == outcome) {
                uint256 reward = arbFee / winners;
                paidToPanel += reward;
                token.safeTransfer(v, reward);
            }
        }
        uint256 distributable = remaining - paidToPanel;

        if (outcome == Vote.Buyer) {
            token.safeTransfer(e.buyer, distributable);
            emit EscrowSettled(orderId, 1);
        } else if (outcome == Vote.Seller) {
            _paySeller(e, token, distributable);
            emit EscrowSettled(orderId, 0);
        } else {
            uint256 half = distributable / 2;
            token.safeTransfer(e.buyer, distributable - half);
            _paySeller(e, token, half);
            emit EscrowSettled(orderId, 2);
        }
        emit DisputeResolved(orderId, outcome, d.buyerVotes, d.sellerVotes);
    }

    function _paySeller(Escrow storage e, IERC20 token, uint256 gross) internal {
        uint256 fee = (gross * e.feeBps) / 10_000;
        if (fee > 0) token.safeTransfer(treasury, fee);
        token.safeTransfer(e.seller, gross - fee);
    }

    function _isPanelist(Dispute storage d, address v) internal view returns (bool) {
        for (uint256 k; k < d.panel.length; ++k) if (d.panel[k] == v) return true;
        return false;
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------
    function getEscrow(bytes32 orderId)
        external
        view
        returns (
            address buyer,
            address seller,
            address token,
            uint256 amount,
            uint256 released,
            Status status,
            uint64[] memory deliveredAt,
            uint256 releasedMask
        )
    {
        Escrow storage e = _escrows[orderId];
        return (e.buyer, e.seller, e.token, e.amount, e.released, e.status, e.deliveredAt, e.releasedMask);
    }

    function getPanel(bytes32 orderId) external view returns (address[] memory panel, uint64 commitDeadline, uint64 revealDeadline) {
        Dispute storage d = _disputes[orderId];
        return (d.panel, d.commitDeadline, d.revealDeadline);
    }
}

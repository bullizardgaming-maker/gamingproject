// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IVRFCoordinatorV2Plus} from "../MarketEscrow.sol";

interface IVRFConsumer {
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external;
}

/// @dev Stand-in for Chainlink's VRF v2.5 coordinator: records requests and lets a test answer
/// them with chosen words, the way the real coordinator calls back. Test use only.
contract MockVRFCoordinator is IVRFCoordinatorV2Plus {
    struct Pending {
        address consumer;
        RandomWordsRequest req;
    }

    uint256 public lastRequestId;
    mapping(uint256 => Pending) internal _pending;

    function requestRandomWords(RandomWordsRequest calldata req) external returns (uint256 requestId) {
        requestId = ++lastRequestId;
        _pending[requestId] = Pending(msg.sender, req);
    }

    function requestOf(uint256 requestId) external view returns (address consumer, bytes32 keyHash, uint256 subId, uint32 numWords, bytes memory extraArgs) {
        Pending storage p = _pending[requestId];
        return (p.consumer, p.req.keyHash, p.req.subId, p.req.numWords, p.req.extraArgs);
    }

    function fulfill(uint256 requestId, uint256 word) external {
        uint256[] memory words = new uint256[](1);
        words[0] = word;
        IVRFConsumer(_pending[requestId].consumer).rawFulfillRandomWords(requestId, words);
    }
}

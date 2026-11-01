// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.26;

import {ILaunchObservations} from "../contracts/ILaunchObservations.sol";

interface IChainBlockNumber {
    function arbBlockNumber() external view returns (uint256);
}

/// @author Ted (@haot3x)
/// @notice Local reader example for one liquidity minimum, not a trading guard or safety verdict.
/// @dev Trusts a fixed registry and detector. Cross-chain readings are unsupported: this reader has no
/// authenticated source headers. hashChecked reflects the registry's check at recording time, not finality.
contract LiquidityObservationReader {
    bytes32 public constant LP_LOCKED_SHARE = keccak256("erc.launch-observations.signal.lpLockedShare");
    address private constant ARB_SYS = address(100);

    ILaunchObservations public immutable registry;
    address public immutable detector;
    uint64 public immutable maxAgeBlocks;
    uint16 public immutable minimumLockedBps;

    error InvalidPolicy();
    error UnsupportedChain();
    error NoObservation();
    error ContextMismatch();
    error UncheckedHash();
    error StaleObservation();
    error MissingOrLowLiquidity();

    constructor(ILaunchObservations registry_, address detector_, uint64 maxAgeBlocks_, uint16 minimumLockedBps_) {
        if (
            address(registry_).code.length == 0 || detector_ == address(0) || maxAgeBlocks_ == 0
                || minimumLockedBps_ == 0 || minimumLockedBps_ > 10_000
        ) revert InvalidPolicy();
        registry = registry_;
        detector = detector_;
        maxAgeBlocks = maxAgeBlocks_;
        minimumLockedBps = minimumLockedBps_;
    }

    function requireLockedLiquidity(uint256 sourceChainId, address token)
        external
        view
        returns (uint256 id, uint256 lockedBps)
    {
        if (sourceChainId != block.chainid) revert UnsupportedChain();
        id = registry.latestByToken(sourceChainId, token, detector);
        if (id == 0) revert NoObservation();
        (ILaunchObservations.Observation memory o, ILaunchObservations.Finding[] memory findings) =
            registry.getObservation(id);
        if (o.chainId != sourceChainId || o.token != token || o.detector != detector) revert ContextMismatch();
        if (!o.hashChecked) revert UncheckedHash();
        uint256 current = ARB_SYS.code.length == 0 ? block.number : IChainBlockNumber(ARB_SYS).arbBlockNumber();
        // recordedAt is publication time. A correction cannot make the observed block younger.
        if (o.observedBlock == 0 || o.observedBlock >= current || current - o.observedBlock > maxAgeBlocks) {
            revert StaleObservation();
        }
        for (uint256 i; i < findings.length; ++i) {
            if (findings[i].kind == LP_LOCKED_SHARE && findings[i].param == 0) {
                lockedBps = findings[i].value;
                // The not-read sentinel passes an ordinary lower-bound comparison.
                if (lockedBps == type(uint256).max || lockedBps < minimumLockedBps) revert MissingOrLowLiquidity();
                return (id, lockedBps);
            }
        }
        revert MissingOrLowLiquidity();
    }
}

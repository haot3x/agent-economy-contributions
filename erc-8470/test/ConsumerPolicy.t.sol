// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.26;

import {ILaunchObservations as I} from "../contracts/ILaunchObservations.sol";
import {LaunchObservations} from "../contracts/LaunchObservations.sol";
import {LiquidityObservationReader as Reader} from "../consumer/LiquidityObservationReader.sol";
import {Vm, MockArbSys, MockBlockHistory} from "./Mocks.sol";

/// @author Ted (@haot3x)
/// @notice Local consumer regressions against the unmodified upstream registry, using upstream chain mocks.
contract ConsumerPolicyTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address private constant DETECTOR = address(0xA11CE);
    address private constant TOKEN = address(0x7011);
    address private constant HISTORY = 0x0000F90827F1C53a10cb7A02335B175320002935;
    address private constant ARB_SYS = address(100);
    bytes32 private constant LOCKED = keccak256("erc.launch-observations.signal.lpLockedShare");
    bytes32 private constant BLOCK_HASH = keccak256("fixture source block");

    LaunchObservations private registry;
    Reader private reader;

    function setUp() public {
        vm.chainId(1);
        vm.roll(1_000);
        vm.warp(1_800_000_000);
        registry = new LaunchObservations(address(0));
        reader = new Reader(registry, DETECTOR, 100, 8_000);
        vm.etch(HISTORY, address(new MockBlockHistory()).code);
    }

    function _record(uint256 chain, uint64 at, uint256 value, bool includeFinding, address author)
        private
        returns (uint256 id)
    {
        if (chain == block.chainid) MockBlockHistory(payable(HISTORY)).setHash(at, BLOCK_HASH);
        I.ObservationInput memory input;
        input.kind = I.KeyKind.Token;
        input.chainId = chain;
        input.token = TOKEN;
        input.observedBlock = at;
        input.observedBlockHash = BLOCK_HASH;
        input.reportHash = keccak256("synthetic fixture report");
        input.reportURI = "ipfs://fixture";
        I.Finding[] memory findings = new I.Finding[](includeFinding ? 1 : 0);
        if (includeFinding) findings[0] = I.Finding(LOCKED, value, 0, I.Lean.None);
        vm.prank(author);
        (id,) = registry.recordObservation(input, findings);
    }

    function _read() private view returns (uint256 id, uint256 value) {
        return reader.requireLockedLiquidity(block.chainid, TOKEN);
    }

    function test_AcceptsMeasuredMinimumAtExactAgeBoundary() public {
        uint256 expected = _record(1, 900, 8_000, true, DETECTOR);
        (uint256 id, uint256 value) = _read();
        require(id == expected && value == 8_000, "measured minimum at inclusive age bound");
    }

    function test_NotReadPassesNaiveMinimumButReaderRejectsIt() public {
        _record(1, 999, type(uint256).max, true, DETECTOR);
        (,,, uint256 naiveValue,) = registry.latestFinding(1, TOKEN, DETECTOR, LOCKED, 0);
        require(naiveValue >= 8_000, "negative control: naive minimum passes not read");
        vm.expectRevert(Reader.MissingOrLowLiquidity.selector);
        reader.requireLockedLiquidity(1, TOKEN);
    }

    function test_MissingFindingCannotPassMinimum() public {
        _record(1, 999, 0, false, DETECTOR);
        vm.expectRevert(Reader.MissingOrLowLiquidity.selector);
        reader.requireLockedLiquidity(1, TOKEN);
    }

    function test_MeasuredBelowMinimumIsRejected() public {
        _record(1, 999, 7_999, true, DETECTOR);
        vm.expectRevert(Reader.MissingOrLowLiquidity.selector);
        reader.requireLockedLiquidity(1, TOKEN);
    }

    function test_MissingObservationIsRejected() public {
        vm.expectRevert(Reader.NoObservation.selector);
        reader.requireLockedLiquidity(1, TOKEN);
    }

    function test_UntrustedDetectorCannotSupplyReading() public {
        _record(1, 999, 10_000, true, address(0xBAD));
        vm.expectRevert(Reader.NoObservation.selector);
        reader.requireLockedLiquidity(1, TOKEN);
    }

    function test_LatePublicationDoesNotRefreshOldSourceBlock() public {
        vm.roll(1_001);
        uint256 id = _record(1, 900, 9_000, true, DETECTOR);
        (I.Observation memory o,) = registry.getObservation(id);
        require(o.hashChecked && o.recordedAt == block.timestamp, "valid hash, just published");
        vm.expectRevert(Reader.StaleObservation.selector);
        reader.requireLockedLiquidity(1, TOKEN);
    }

    function test_SameBlockCorrectionDoesNotRefreshAge() public {
        uint256 first = _record(1, 900, 9_000, true, DETECTOR);
        _read();
        vm.roll(1_001);
        vm.warp(block.timestamp + 3_600);
        uint256 correction = _record(1, 900, 10_000, true, DETECTOR);
        (I.Observation memory o,) = registry.getObservation(correction);
        require(o.supersedes == first && o.recordedAt == block.timestamp, "fresh correction of old block");
        vm.expectRevert(Reader.StaleObservation.selector);
        reader.requireLockedLiquidity(1, TOKEN);
    }

    function test_LatestNotReadDoesNotFallBackToOlderGoodValue() public {
        _record(1, 998, 9_000, true, DETECTOR);
        _read();
        _record(1, 999, type(uint256).max, true, DETECTOR);
        vm.expectRevert(Reader.MissingOrLowLiquidity.selector);
        reader.requireLockedLiquidity(1, TOKEN);
    }

    function test_CrossChainFreshPublicationRemainsUnsupported() public {
        uint256 id = _record(4663, 1, 10_000, true, DETECTOR);
        (I.Observation memory o,) = registry.getObservation(id);
        require(o.recordedAt == block.timestamp && !o.hashChecked, "recent publication, unknown source age");
        vm.expectRevert(Reader.UnsupportedChain.selector);
        reader.requireLockedLiquidity(4663, TOKEN);
    }

    function test_ArbitrumUsesL2BlockNumberForFreshness() public {
        vm.chainId(4663);
        vm.etch(ARB_SYS, address(new MockArbSys()).code);
        vm.mockCall(ARB_SYS, abi.encodeWithSignature("arbBlockNumber()"), abi.encode(uint256(1_000_000)));
        _record(4663, 999_900, 8_000, true, DETECTOR);
        (, uint256 value) = _read();
        require(value == 8_000 && block.number == 1_000, "L2 age, not parent block.number");
    }

    function test_UncheckedOwnChainHashIsRejected() public {
        // Record on a plain EVM before the blockhash window with no readable history hash.
        uint256 id = _record(1, 900, 9_000, true, DETECTOR);
        // A separate registry call now has no history contract and a blockhash outside the window.
        vm.etch(HISTORY, bytes(""));
        vm.roll(1_300);
        I.ObservationInput memory input;
        input.kind = I.KeyKind.Token;
        input.chainId = 1;
        input.token = TOKEN;
        input.observedBlock = 901;
        input.observedBlockHash = BLOCK_HASH;
        input.reportHash = keccak256("unverified report");
        input.reportURI = "ipfs://fixture";
        I.Finding[] memory f = new I.Finding[](1);
        f[0] = I.Finding(LOCKED, 9_000, 0, I.Lean.None);
        vm.prank(DETECTOR);
        (uint256 next,) = registry.recordObservation(input, f);
        require(next > id, "latest observation");
        // A wider age policy isolates hash verification from the stale-block check.
        Reader wider = new Reader(registry, DETECTOR, 1_000, 8_000);
        vm.expectRevert(Reader.UncheckedHash.selector);
        wider.requireLockedLiquidity(1, TOKEN);
    }
}

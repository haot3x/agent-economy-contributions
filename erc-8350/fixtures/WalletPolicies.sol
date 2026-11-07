// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.24;

import {AgentMemoryStateRegistry} from "../upstream/AgentMemoryStateRegistry.sol";
import {Safe} from "safe/Safe.sol";
import {SafeProxy} from "safe/proxies/SafeProxy.sol";
import {CompatibilityFallbackHandler} from "safe/handler/CompatibilityFallbackHandler.sol";
import {SignMessageLib} from "safe/libraries/SignMessageLib.sol";

/// @notice Local test policy, also used as a real EIP-7702 delegation target.
/// @dev Deliberately supports malformed responses. Not a production wallet.
contract WalletPolicies {
    address public immutable testOwner;
    uint8 public mode;
    bytes32 public approvedDigest;
    bytes32 public approvedSignatureHash;

    constructor(address owner) {
        testOwner = owner;
    }

    function configure(uint8 nextMode, bytes32 digest, bytes32 signatureHash) external {
        require(msg.sender == testOwner, "test owner only");
        mode = nextMode;
        approvedDigest = digest;
        approvedSignatureHash = signatureHash;
    }

    function ping() external pure returns (uint256) {
        return 8350;
    }

    function forward(address target, bytes calldata data) external {
        require(msg.sender == testOwner, "test owner only");
        (bool ok, bytes memory result) = target.call(data);
        if (!ok) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
    }

    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4) {
        uint8 m = mode;
        if (m == 1) revert("policy denied");
        if (m == 2) {
            assembly {
                mstore(0, or(shl(224, 0x1626ba7e), 1))
                return(0, 32)
            }
        }
        if (m == 3) {
            assembly {
                mstore(0, shl(224, 0x1626ba7e))
                return(0, 4)
            }
        }
        if (digest != approvedDigest || keccak256(signature) != approvedSignatureHash) return 0xffffffff;
        if (m == 4) {
            assembly {
                mstore(0, shl(224, 0x1626ba7e))
                mstore(32, 0x8350)
                return(0, 64)
            }
        }
        return m == 5 ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}

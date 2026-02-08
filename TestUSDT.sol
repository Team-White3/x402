// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

contract TestUSDT is ERC20, EIP712 {
    using ECDSA for bytes32;

    // EIP-3009 的哈希常量
    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH =
        keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)");

    mapping(address => mapping(bytes32 => bool)) public authorizationUsed;

    constructor() ERC20("Test USDT", "USDT") EIP712("Test USDT", "1") {
        // 给部署者铸造 100万个测试 USDT (6位小数)
        _mint(msg.sender, 1000000 * 10**6);
    }

    // 重写精度为 6 位
    function decimals() public view virtual override returns (uint8) {
        return 6;
    }

    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        require(block.timestamp > validAfter, "Authorization not yet valid");
        require(block.timestamp < validBefore, "Authorization expired");
        require(!authorizationUsed[from][nonce], "Authorization used");

        bytes32 structHash = keccak256(
            abi.encode(
                TRANSFER_WITH_AUTHORIZATION_TYPEHASH,
                from,
                to,
                value,
                validAfter,
                validBefore,
                nonce
            )
        );

        bytes32 hash = _hashTypedDataV4(structHash);
        address signer = ECDSA.recover(hash, v, r, s);
        
        require(signer == from, "Invalid signature");

        authorizationUsed[from][nonce] = true;
        _transfer(from, to, value);
    }
}
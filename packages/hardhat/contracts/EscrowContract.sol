// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transfer(address to, uint amount) external returns (bool);
    function transferFrom(address from, address to, uint amount) external returns (bool);
}

contract EscrowContract {
    struct Escrow {
        uint64 createdTime;
        uint64 rescueTime;
        address tokenAddress; // address(0) for ETH
        uint256 amount;
        address creator;
        address taker;
        bytes32 secretHash;
    }

    address public admin;
    mapping(bytes32 => Escrow) public escrows;
    mapping(address => uint256) public totalDeposits;

    constructor() {
        admin = msg.sender;
    }

    function create(
        address tokenAddress,
        uint256 amount,
        uint64 rescueDelay,
        bytes32 secretHash,
        address taker
    ) external payable {
        require(secretHash != bytes32(0), "Secret hash cannot be empty");
        require(escrows[secretHash].creator == address(0), "Escrow already exists");

        uint256 depositAmount = amount;
        if (tokenAddress == address(0)) {
            require(msg.value == depositAmount, "Incorrect ETH sent");
        } else {
            require(IERC20(tokenAddress).transferFrom(msg.sender, address(this), amount), "Token transfer failed");
        }

        escrows[secretHash] = Escrow({
            createdTime: uint64(block.timestamp),
            rescueTime: uint64(block.timestamp + rescueDelay),
            tokenAddress: tokenAddress,
            amount: amount,
            creator: msg.sender,
            taker: taker,
            secretHash: secretHash
        });

        totalDeposits[tokenAddress] += depositAmount;
    }

    function withdraw(bytes32 secretHash, bytes calldata secret) external {
        Escrow memory escrow = escrows[secretHash];
        require(escrow.creator != address(0), "Escrow does not exist");
        require(block.timestamp < escrow.rescueTime, "Rescue time passed");
        require(keccak256(abi.encodePacked(secret)) == secretHash, "Incorrect secret");

        _send(escrow.taker == address(0) ? msg.sender : escrow.taker, escrow.tokenAddress, escrow.amount);
        delete escrows[secretHash];
    }

    function cancel(bytes32 secretHash) external {
        Escrow memory escrow = escrows[secretHash];
        require(escrow.creator != address(0), "Escrow does not exist");
        require(block.timestamp >= escrow.rescueTime, "Rescue time not passed");

        delete escrows[secretHash];
        _send(escrow.creator, escrow.tokenAddress, escrow.amount);
    }

    function _send(address to, address token, uint256 amount) internal {
        totalDeposits[token] -= amount;
        if (token == address(0)) {
            (bool sent, ) = to.call{value: amount}("");
            require(sent, "ETH transfer failed");
        } else {
            require(IERC20(token).transfer(to, amount), "Token transfer failed");
        }
    }
}

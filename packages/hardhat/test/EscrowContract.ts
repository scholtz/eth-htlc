// test/EscrowContract.test.ts
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { expect } from "chai";
import { keccak256, parseEther, toUtf8Bytes } from "ethers";
import { ethers } from "hardhat";
import { ERC20Mock, EscrowContract } from "../typechain-types"; // adjust import paths as needed

describe("EscrowContract", () => {
  async function deployFixture() {
    const [owner, taker, stranger, creator] = await ethers.getSigners();

    const ERC20MockFactory = await ethers.getContractFactory("ERC20Mock");
    const token = (await ERC20MockFactory.deploy()) as ERC20Mock;

    const EscrowFactory = await ethers.getContractFactory("EscrowContract");
    const escrow = (await EscrowFactory.deploy()) as EscrowContract;
    ethers.getContractAt("EscrowContract", "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0");

    return { owner, taker, stranger, token, escrow, creator };
  }

  describe("ETH Escrow", () => {
    it("should create and withdraw ETH escrow", async () => {
      const { taker, escrow, creator } = await loadFixture(deployFixture);
      const secret = toUtf8Bytes("secret123"); // bytes instead of string
      const secretHash = keccak256(secret);
      const amount = parseEther("1");
      const rescueDelay = 3600;
      const tx = { value: amount };
      await escrow.connect(creator).create(ethers.ZeroAddress, amount, rescueDelay, secretHash, taker.address, tx);

      // Fetch escrow by secretHash
      const escrowData = await escrow.escrows(secretHash);

      // Check escrow struct fields
      expect(escrowData.creator).to.equal(creator.address);
      expect(escrowData.taker).to.equal(taker.address);
      expect(escrowData.tokenAddress).to.equal(ethers.ZeroAddress);
      expect(escrowData.amount).to.equal(amount);
      expect(escrowData.secretHash).to.equal(secretHash);

      await expect(() => escrow.connect(taker).withdraw(secretHash, secret)).to.changeEtherBalances(
        [escrow, taker],
        [amount * -1n, amount],
      );
    });

    it("should revert on incorrect secret", async () => {
      const { taker, escrow } = await loadFixture(deployFixture);
      const secret = toUtf8Bytes("secret123");
      const wrongSecret = toUtf8Bytes("wrong123");
      const secretHash = keccak256(secret);
      const amount = parseEther("1");
      const rescueDelay = 3600;

      await escrow.create(ethers.ZeroAddress, amount, rescueDelay, secretHash, taker.address, { value: amount });

      await expect(escrow.connect(taker).withdraw(secretHash, wrongSecret)).to.be.revertedWith("Incorrect secret");
    });

    it("should allow cancel after rescue time", async () => {
      const { owner, escrow } = await loadFixture(deployFixture);
      const secret = toUtf8Bytes("cancelme");
      const secretHash = keccak256(secret);
      const amount = parseEther("1");
      const rescueDelay = 3600;

      await escrow.create(ethers.ZeroAddress, amount, rescueDelay, secretHash, owner.address, { value: amount });

      await time.increase(rescueDelay + 1);

      await expect(() => escrow.cancel(secretHash)).to.changeEtherBalances([escrow, owner], [amount * -1n, amount]);
    });
    it("should revert if escrow already exists", async () => {
      const { taker, escrow } = await loadFixture(deployFixture);
      const secret = toUtf8Bytes("duplicate");
      const hash = keccak256(secret);
      const amount = parseEther("1");

      await escrow.create(ethers.ZeroAddress, amount, 3600, hash, taker.address, { value: amount });
      await expect(
        escrow.create(ethers.ZeroAddress, amount, 3600, hash, taker.address, { value: amount }),
      ).to.be.revertedWith("Escrow already exists");
    });

    it("should revert withdraw after rescue time", async () => {
      const { taker, escrow } = await loadFixture(deployFixture);
      const secret = toUtf8Bytes("expire");
      const hash = keccak256(secret);
      const amount = parseEther("1");

      await escrow.create(ethers.ZeroAddress, amount, 1, hash, taker.address, { value: amount });
      await time.increase(2);
      await expect(escrow.connect(taker).withdraw(hash, secret)).to.be.revertedWith("Rescue time passed");
    });

    it("should allow taker to be zero (open claim)", async () => {
      const { stranger, escrow } = await loadFixture(deployFixture);
      const secret = toUtf8Bytes("open-secret");
      const hash = keccak256(secret);
      const amount = parseEther("1");

      await escrow.create(ethers.ZeroAddress, amount, 3600, hash, ethers.ZeroAddress, { value: amount });

      await expect(() => escrow.connect(stranger).withdraw(hash, secret)).to.changeEtherBalances(
        [escrow, stranger],
        [amount * -1n, amount],
      );
    });

    it("should fail ETH escrow if msg.value mismatch", async () => {
      const { taker, escrow } = await loadFixture(deployFixture);
      const secretHash = keccak256(toUtf8Bytes("badval"));
      await expect(
        escrow.create(ethers.ZeroAddress, parseEther("1"), 3600, secretHash, taker.address, {
          value: parseEther("0.5"),
        }),
      ).to.be.revertedWith("Incorrect ETH sent");
    });
    it("should set deployer as admin", async () => {
      const { owner, escrow } = await loadFixture(deployFixture);
      expect(await escrow.admin()).to.equal(owner.address);
    });
  });
});

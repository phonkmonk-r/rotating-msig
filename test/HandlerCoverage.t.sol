// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {console2} from "forge-std/console2.sol";
import {RotationHandler} from "./RotationGuard.invariant.t.sol";
import {RotationFixture} from "./utils/RotationFixture.sol";

contract HandlerCoverageTest is RotationFixture {
    function test_coverage() public {
        RotationHandler h = new RotationHandler(safe, guard, multiSend, SLOTS, legacyOwners, recipient);
        uint256[13] memory tried;
        uint256[13] memory ok;
        for (uint256 i = 0; i < 1500; ++i) {
            uint256 r = uint256(keccak256(abi.encode(i)));
            uint256 kind = r % 13;
            uint256 before = h.executions();
            if (kind == 0) h.execute(r >> 8, (r >> 9) & 1 == 1, (r >> 10) % 4 == 0);
            else if (kind == 1) h.stage(r >> 8, r >> 16, address(uint160(r >> 40)));
            else if (kind == 2) h.forceRotate(r >> 8, r >> 16);
            else if (kind == 3) h.skipTo(r >> 8, r >> 16, uint8(r >> 24));
            else if (kind == 4) h.setRoot(r >> 8, r >> 16, (r >> 30) & 1 == 1, uint32(r >> 40));
            else if (kind == 5) h.changeThreshold(r >> 8, r >> 16);
            else if (kind == 6) h.removeSlot(r >> 8, r >> 16);
            else if (kind == 7) h.addSlot(r >> 8);
            else if (kind == 8) h.reinitialize(r >> 8, (r >> 30) & 1 == 1);
            else if (kind == 9) h.adversarialTx(r >> 8, uint8(r >> 16), address(uint160(r >> 40)));
            else if (kind == 10) h.rogueModule(r >> 8);
            else if (kind == 11) h.badSignatures(r >> 8, uint8(r >> 16), address(uint160(r >> 40)));
            else h.stageArbitrary(r >> 8, uint32(r >> 16) % 20, address(uint160(r >> 40)), r >> 60, (r >> 61) & 1 == 1);
            tried[kind]++;
            if (h.executions() > before) ok[kind]++;
        }
        string[13] memory names = ["execute", "stage", "forceRotate", "skipTo", "setRoot", "threshold", "removeSlot", "addSlot", "reinit", "adversarial", "rogue", "badSigs", "stageArb"];
        for (uint256 k = 0; k < 13; ++k) console2.log(names[k], tried[k], ok[k]);
        console2.log("owners", safe.getOwners().length, "threshold", safe.getThreshold());
        for (uint256 k = 0; k < 9; ++k) if (k != 1) assertGt(ok[k], 0, names[k]);
        assertFalse(h.adversarialSucceeded());
        assertFalse(h.rotationMissed());
        assertFalse(h.honestStageFailed());
        assertFalse(h.badStageAccepted());
    }
}

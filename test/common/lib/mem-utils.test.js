const { assert } = require('../../helpers/assert')

const MemUtilsTest = artifacts.require('MemUtilsTest')


contract('AccountingOracle', () => {
  let memUtilsTest

  before(async () => {
    memUtilsTest = await MemUtilsTest.new()
  })

  context('MemUtils.memcpy', () => {

    it('copies mem chunks that are multiples of 32 bytes', async () => {
      await memUtilsTest.memcpy_copies_mem_chunks_that_are_multiples_of_32_bytes()
    })

    it('copies mem chunks that are multiples of 32 bytes from a non-32 byte offset', async () => {
      await memUtilsTest.memcpy_copies_mem_chunks_that_are_multiples_of_32_bytes_from_a_non_32b_offset()
    })

    it('copies mem chunks that are multiples of 32 bytes to a non-32 byte offset', async () => {
      await memUtilsTest.memcpy_copies_mem_chunks_that_are_multiples_of_32b_to_a_non_32b_offset()
    })

    it('copies mem chunks that are multiples of 32 bytes from and to a non-32 byte offset', async () => {
      await memUtilsTest.memcpy_copies_mem_chunks_that_are_multiples_of_32_bytes_from_and_to_a_non_32b_offset()
    })

    it('copies mem chunks that are not multiples of 32 bytes', async () => {
      await memUtilsTest.memcpy_copies_mem_chunks_that_are_not_multiples_of_32_bytes()
    })

    it('copies mem chunks that are not multiples of 32 bytes from a non-32 byte offset', async () => {
      await memUtilsTest.memcpy_copies_mem_chunks_that_are_not_multiples_of_32_bytes_from_a_non_32b_offset()
    })

    it('copies mem chunks that are not multiples of 32 bytes to a non-32 byte offset', async () => {
      await memUtilsTest.memcpy_copies_mem_chunks_that_are_not_multiples_of_32_bytes_to_a_non_32b_offset()
    })

    it('copies mem chunks that are not multiples of 32 bytes from and to a non-32 byte offset', async () => {
      await memUtilsTest.memcpy_copies_mem_chunks_that_are_not_multiples_of_32_bytes_from_and_to_a_non_32b_offset()
    })

    it('copies mem chunks shorter than 32 bytes', async () => {
      await memUtilsTest.memcpy_copies_mem_chunks_shorter_than_32_bytes()
    })

    it('copies mem chunks shorter than 32 bytes from a non-32 byte offset', async () => {
      await memUtilsTest.memcpy_copies_mem_chunks_shorter_than_32_bytes_from_a_non_32b_offset()
    })

    it('copies mem chunks shorter than 32 bytes to a non-32 byte offset', async () => {
      await memUtilsTest.memcpy_copies_mem_chunks_shorter_than_32_bytes_to_a_non_32b_offset()
    })

    it('copies mem chunks shorter than 32 bytes from and to a non-32 byte offset', async () => {
      await memUtilsTest.memcpy_copies_mem_chunks_shorter_than_32_bytes_from_and_to_a_non_32b_offset()
    })

    it('zero length is handled correctly', async () => {
      await memUtilsTest.memcpy_zero_length_is_handled_correctly()
    })
  })

  context('MemUtils.keccakUint256Array', () => {

    it('calculates a keccak256 over a uint256 array', async () => {
      await memUtilsTest.keccakUint256Array_calcs_keccak_over_a_uint_array()
    })

    it('calculates a keccak256 over an empty uint256 array', async () => {
      await memUtilsTest.keccakUint256Array_calcs_keccak_over_an_empty_array()
    })
  })

  context('MemUtils.trimUint256Array', () => {

    it('decreases length of a uint256 array', async () => {
      await memUtilsTest.trimUint256Array_decreases_length_of_a_uint_array()
    })

    it('allows trimming to a zero length', async () => {
      await memUtilsTest.trimUint256Array_allows_trimming_to_zero_length()
    })

    it('reverts on trying to trim by more than the array length', async () => {
      await assert.reverts(
        memUtilsTest.trimUint256Array_reverts_on_trying_to_trim_by_more_than_length()
      )
    })
  })
})

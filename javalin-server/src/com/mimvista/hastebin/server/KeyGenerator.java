package com.mimvista.hastebin.server;

import java.util.Random;

public class KeyGenerator {
	// These should probably be read from a config file at some point
	// When that code is added, make sure to throw an exception if the config
	// contains an alphabet that uses the '.' character, as having that included
	// in keys would break our extension handling logic in some cases.
	// It's better to get an exception with a clear error message than random
	// weird behavior and breakages.
	
	/** Generate keys with this length */
	private static final int KEY_LENGTH = 10;
	/**
	 * Alphabet of uppercase characters.  Some characters are omitted to prevent
	 * generating keys with characters that are hard to identify at a glance
	 * (Ex: Il or O0)
	 */
	private static final String UPPERCASE = "ABCDEFGHJKMNPRSTWXYZ";
	/**
	 * Alphabet of lowercase characters.  Some characters are omitted to prevent
	 * generating keys with characters that are hard to identify at a glance
	 * (Ex: Il or ij)
	 */
	private static final String LOWERCASE = "abcdefhkmnprstwxyz";
	/**
	 * Alphabet of numeric characters.  Some characters are omitted to prevent
	 * generating keys with characters that are hard to identify at a glance
	 * (Ex: O0 or 1l)
	 */
	private static final String NUMBERS = "23456789";
	/**
	 * A sequence of alphabets to pull random characters from when making a key.
	 * For example, if you used { UPPERCASE, LOWERCASE } the generated keys would
	 * look like "AkWmRtCpPe", alternating uppercase/lowercase characters until
	 * the key length is hit.
	 */
	private static final String[] SEQUENCE = { UPPERCASE, LOWERCASE, LOWERCASE };
	
	private static Random random = new Random();
	
	public static String generateKey() {
		StringBuilder sb = new StringBuilder(KEY_LENGTH);
		for (int i = 0; i < KEY_LENGTH; i++) {
			String alphabet = SEQUENCE[i % SEQUENCE.length];
			char c = alphabet.charAt(random.nextInt(alphabet.length()));
			sb.append(c);
		}
		return sb.toString();
	}
}

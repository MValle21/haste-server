package com.mimvista.hastebin.server;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.Base64;
import java.util.zip.GZIPInputStream;
import java.util.zip.GZIPOutputStream;

import com.fasterxml.jackson.annotation.JsonAutoDetect.Visibility;
import com.fasterxml.jackson.annotation.PropertyAccessor;
import com.fasterxml.jackson.databind.ObjectMapper;

public class HasteUtils {
	private static ObjectMapper globalMapper;
	
	public static void initializeMapper() {
		ObjectMapper mapper = new ObjectMapper();
		mapper.setVisibility(PropertyAccessor.ALL, Visibility.NONE);
		mapper.setVisibility(PropertyAccessor.FIELD, Visibility.ANY);
		globalMapper = mapper;
	}
	
	public static ObjectMapper mapper() {
		if (globalMapper == null) {
			throw new IllegalStateException("HasteUtils.initializeMapper() hasn't been called yet");
		}
		return globalMapper;
	}
	
	public static String encodeInfo(HasteInfo info) {
		try {
			return mapper().writeValueAsString(info);
		} catch (IOException ex) {
			throw new RuntimeException(ex);
		}
	}
	
	public static HasteInfo decodeInfo(String info) {
		try {
			return mapper().readValue(info, HasteInfo.class);
		} catch (IOException ex) {
			throw new RuntimeException(ex);
		}
	}
	
	public static String encodeData(byte[] data) {
		try (ByteArrayOutputStream output = new ByteArrayOutputStream();
				GZIPOutputStream zipOutput = new GZIPOutputStream(output)) {
			zipOutput.write(data);
			zipOutput.finish();
			zipOutput.flush();
			byte[] zipped = output.toByteArray();
			return Base64.getEncoder().encodeToString(zipped);
		} catch (IOException ex) {
			throw new RuntimeException(ex);
		}
	}
	
	public static byte[] decodeData(String data) {
		try (GZIPInputStream stream = new GZIPInputStream(new ByteArrayInputStream(Base64.getDecoder().decode(data)))) {
			return stream.readAllBytes();
		} catch (IOException ex) {
			throw new RuntimeException(ex);
		}
	}
}

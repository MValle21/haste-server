package com.mimvista.hastebin.server;

import java.io.BufferedInputStream;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.stream.Collectors;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import com.lambdaworks.redis.RedisClient;
import com.lambdaworks.redis.RedisURI;
import com.lambdaworks.redis.api.sync.RedisCommands;

import io.javalin.Context;
import io.javalin.Javalin;
import io.javalin.UploadedFile;
import io.javalin.embeddedserver.Location;
import io.javalin.translator.json.JavalinJacksonPlugin;

/**
 * Main hastebin server entry point.
 * 
 * @author Matt Arpidone
 */
public class ServerMain {
	private static final Logger log = LoggerFactory.getLogger(ServerMain.class);
	
	public static void main(String[] args) {
		HasteUtils.initializeMapper();
		JavalinJacksonPlugin.configure(HasteUtils.mapper());
		
		Javalin.create()
			.before(ctx -> log.info(ctx.method() + ": " + ctx.path()))
			.get("/", ServerMain::getRoot)
			.post("/docs", ServerMain::postDocument)
			.get("/docs/:id", ServerMain::getDocument)
			.head("/docs/:id", ServerMain::headDocument)
			.get("/keys/:keys", ServerMain::getKeys)
			.enableStaticFiles("../static", Location.EXTERNAL)
			.error(404, ServerMain::unknownFileError)
			.exception(Exception.class, ServerMain::handleException)
			.start();
	}
	
	private static void getRoot(Context ctx) {
		try {
			ctx.contentType("text/html");
			ctx.result(new BufferedInputStream(new FileInputStream(new File("../static/index.html"))));
		} catch (IOException ex) {
			throw new RuntimeException(ex);
		}
	}
	
	private static void postDocument(Context ctx) {
		byte[] data;
		HasteInfo.Builder builder = HasteInfo.builder()
				.setName("")
				.setKey(KeyGenerator.generateKey())
				.setMimetype("text/plain")
				.setEncoding("utf-8")
				.setSyntax("");
		
		if (ctx.isMultipart()) {
			UploadedFile file = ctx.uploadedFile("file");
			builder.setName(file.getName());
			builder.setMimetype(file.getContentType());
			try {
				data = file.getContent().readAllBytes();
			} catch (IOException ex) {
				throw new RuntimeException(ex);
			}
		} else {
			data = ctx.body().getBytes(StandardCharsets.UTF_8);
		}
		
		HasteInfo info = builder.setSize(data.length).build();
		Map<String, String> msetMap = new HashMap<>();
		msetMap.put("info." + info.getKey(), HasteUtils.encodeInfo(info));
		msetMap.put("data." + info.getKey(), HasteUtils.encodeData(data));
		
		RedisCommands<String, String> redis = createRedisClient().connect().sync();
		redis.mset(msetMap);
		
		Map<String, String> response = new HashMap<>();
		response.put("name", info.getName());
		response.put("key", info.getKey());
		ctx.json(response);
	}
	
	private static void getDocument(Context ctx) {
		String key = ctx.param("id");
		RedisCommands<String, String> redis = createRedisClient().connect().sync();
		List<String> items = redis.mget("info." + key, "data." + key);
		HasteInfo info = HasteInfo.fromJson(items.get(0));
		String encodedData = items.get(1);
		
		setHeadersFromInfo(info, ctx);
		
		byte[] rawData = HasteUtils.decodeData(encodedData);
		ctx.contentType(info.getMimetype());
		
		try (ByteArrayInputStream dataStream = new ByteArrayInputStream(rawData)) {
			ctx.result(dataStream);
		} catch (IOException ex) {
			throw new RuntimeException(ex);
		}
	}
	
	private static void headDocument(Context ctx) {
		String key = stripExtension(ctx.param("id"));

		RedisCommands<String, String> redis = createRedisClient().connect().sync();
		String infoString = redis.get("info." + key);
		HasteInfo info = HasteInfo.fromJson(infoString);
		
		setHeadersFromInfo(info, ctx);
	}
	
	private static void setHeadersFromInfo(HasteInfo info, Context ctx) {
		ctx.contentType(info.getMimetype());
		ctx.header("content-length", Long.toString(info.getSize()));
		ctx.header("x-haste-key", info.getKey());
		ctx.header("x-haste-name", info.getName());
		ctx.header("x-haste-size", Long.toString(info.getSize()));
		ctx.header("x-haste-syntax", info.getSyntax());
		ctx.header("x-haste-mimetype", info.getMimetype());
		ctx.header("x-haste-encoding", info.getEncoding());
		ctx.header("x-haste-time", Long.toString(info.getTime()));
	}
	
	private static void getKeys(Context ctx) {
		String[] keys = Arrays.stream(ctx.param("keys").split(","))
				.map(key -> "info." + key)
				.toArray(i -> new String[i]);

		RedisCommands<String, String> redis = createRedisClient().connect().sync();
		List<String> infoStrings = redis.mget(keys);
		List<HasteInfo> infos = infoStrings.stream()
			.filter(Objects::nonNull)
			.map(HasteInfo::fromJson)
			.collect(Collectors.toList());
		
		try {
			ctx.contentType("application/json");
			ctx.result(HasteUtils.mapper().writeValueAsString(infos));
		} catch (IOException ex) {
			throw new RuntimeException(ex);
		}
	}
	
	private static void unknownFileError(Context ctx) {
		String key = stripExtension(ctx.path().substring(1));

		RedisCommands<String, String> redis = createRedisClient().connect().sync();
		if (redis.exists("info." + key)) {
			ctx.status(200);
			getRoot(ctx);
		}
	}
	
	private static void handleException(Exception ex, Context ctx) {
		log.error("", ex);
	}
	
	private static RedisClient createRedisClient() {
		RedisURI uri = RedisURI.Builder.redis("192.168.1.5", 6379).withDatabase(2).build(); 
		return RedisClient.create(uri);
	}
	
	private static String stripExtension(String s) {
		int extIndex = s.lastIndexOf('.');
		if (extIndex < 0) {
			return s;
		}
		return s.substring(0, extIndex);
	}
}
